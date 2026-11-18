/* cz-host — supervised native script host (feature 028).
 *
 * Loads one language module via --module <path>.so, validates its ABI,
 * then speaks protocol v1 (NDJSON) on stdin/stdout. Each request line:
 *   {"id":n,"op":"run","path":...,"args":{},"input":..,"cwd":..,
 *    "expected_sha256":..,"limits":{"memBytes":..,"outputBytes":..}}
 * Response carries id/outcome/value/error/stdout/stderr/files/truncated/
 * content_sha256/duration_ms. In-language capture comes from the module;
 * this host additionally captures fd 1/2 during the run (FR-015) and diffs
 * the cwd for new files.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#include <dirent.h>
#endif

#include "cz_script.h"

/* ---------- dynamic module ---------- */

typedef struct {
  void *handle;
  int (*abi_version)(void);
  cz_ctx *(*open)(const cz_config *);
  void (*close)(cz_ctx *);
  int (*run_file)(cz_ctx *, const cz_request *, cz_result **);
  void (*interrupt)(cz_ctx *);
  cz_outcome (*r_outcome)(const cz_result *);
  const char *(*r_value)(const cz_result *);
  const char *(*r_error_type)(const cz_result *);
  const char *(*r_error_message)(const cz_result *);
  const char *(*r_error_traceback)(const cz_result *);
  const char *(*r_error_file)(const cz_result *);
  long (*r_error_line)(const cz_result *);
  const char *(*r_stdout)(const cz_result *);
  const char *(*r_stderr)(const cz_result *);
  const char *(*r_content_sha256)(const cz_result *);
  long (*r_duration_ms)(const cz_result *);
  void (*r_free)(cz_result *);
} cz_module;

static cz_ctx *g_ctx;
static cz_module g_mod;

static int load_module(const char *path, cz_module *m, char *err, size_t errn) {
  m->handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!m->handle) {
    snprintf(err, errn, "dlopen %s: %s", path, dlerror());
    return -1;
  }
#define SYM(field, name)                                                \
  m->field = dlsym(m->handle, name);                                    \
  if (!m->field) {                                                      \
    snprintf(err, errn, "%s: missing symbol %s", path, name);           \
    return -1;                                                          \
  }
  SYM(abi_version, "cz_abi_version")
  SYM(open, "cz_open")
  SYM(close, "cz_close")
  SYM(run_file, "cz_run_file")
  SYM(interrupt, "cz_interrupt")
  SYM(r_outcome, "cz_result_outcome")
  SYM(r_value, "cz_result_value")
  SYM(r_error_type, "cz_result_error_type")
  SYM(r_error_message, "cz_result_error_message")
  SYM(r_error_traceback, "cz_result_error_traceback")
  SYM(r_error_file, "cz_result_error_file")
  SYM(r_error_line, "cz_result_error_line")
  SYM(r_stdout, "cz_result_stdout")
  SYM(r_stderr, "cz_result_stderr")
  SYM(r_content_sha256, "cz_result_content_sha256")
  SYM(r_duration_ms, "cz_result_duration_ms")
  SYM(r_free, "cz_result_free")
#undef SYM
  if (m->abi_version() != CZ_ABI_VERSION) {
    snprintf(err, errn, "%s: ABI %u, host expects %u",
             path, m->abi_version(), CZ_ABI_VERSION);
    return -1;
  }
  return 0;
}

/* ---------- signals ---------- */

static void on_sigint(int sig) {
  (void)sig;
  if (g_ctx && g_mod.interrupt) g_mod.interrupt(g_ctx);
}

/* ---------- growable byte buffer ---------- */

typedef struct { char *p; size_t n, cap; } buf;

static void buf_putn(buf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 4096;
    while (b->n + n + 1 > cap) cap *= 2;
    b->p = realloc(b->p, cap);
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}

static void buf_puts(buf *b, const char *s) { if (s) buf_putn(b, s, strlen(s)); }

static void buf_json_str(buf *b, const char *s) {
  buf_putn(b, "\"", 1);
  if (s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
      char esc[8];
      switch (*p) {
        case '"': buf_puts(b, "\\\""); break;
        case '\\': buf_puts(b, "\\\\"); break;
        case '\n': buf_puts(b, "\\n"); break;
        case '\r': buf_puts(b, "\\r"); break;
        case '\t': buf_puts(b, "\\t"); break;
        default:
          if (*p < 0x20) {
            snprintf(esc, sizeof esc, "\\u%04x", *p);
            buf_puts(b, esc);
          } else {
            buf_putn(b, (const char *)p, 1);
          }
      }
    }
  }
  buf_putn(b, "\"", 1);
}

static void buf_json_key(buf *b, const char *k, const char *v) {
  buf_json_str(b, k);
  buf_putn(b, ":", 1);
  buf_json_str(b, v);
}

/* ---------- minimal JSON parse ---------- */

typedef struct { const char *p, *end; } js;

static void js_ws(js *j) { while (j->p < j->end && (*j->p == ' ' || *j->p == '\t')) j->p++; }

static int js_lit(js *j, const char *lit) {
  size_t n = strlen(lit);
  if ((size_t)(j->end - j->p) >= n && memcmp(j->p, lit, n) == 0) { j->p += n; return 1; }
  return 0;
}

/* Parse a JSON string, decoding escapes (incl \uXXXX as UTF-8) into out.
 * Returns pointer past closing quote, or NULL on malformed input. */
static const char *js_string(const char *p, const char *end, char **out) {
  if (p >= end || *p != '"') return NULL;
  p++;
  buf b = {0};
  while (p < end && *p != '"') {
    if (*p == '\\' && p + 1 < end) {
      p++;
      switch (*p) {
        case 'n': buf_putn(&b, "\n", 1); break;
        case 'r': buf_putn(&b, "\r", 1); break;
        case 't': buf_putn(&b, "\t", 1); break;
        case '"': buf_putn(&b, "\"", 1); break;
        case '\\': buf_putn(&b, "\\", 1); break;
        case '/': buf_putn(&b, "/", 1); break;
        case 'b': buf_putn(&b, "\b", 1); break;
        case 'f': buf_putn(&b, "\f", 1); break;
        case 'u': {
          if (p + 4 >= end) goto bad;
          unsigned cp = 0;
          for (int i = 1; i <= 4; i++) {
            char c = p[i];
            cp <<= 4;
            cp |= c >= '0' && c <= '9' ? c - '0'
                : c >= 'a' && c <= 'f' ? c - 'a' + 10
                : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 0;
          }
          p += 4;
          char u8[4]; int u8n = 0;
          if (cp < 0x80) { u8[u8n++] = (char)cp; }
          else if (cp < 0x800) {
            u8[u8n++] = (char)(0xc0 | (cp >> 6));
            u8[u8n++] = (char)(0x80 | (cp & 63));
          } else {
            u8[u8n++] = (char)(0xe0 | (cp >> 12));
            u8[u8n++] = (char)(0x80 | ((cp >> 6) & 63));
            u8[u8n++] = (char)(0x80 | (cp & 63));
          }
          buf_putn(&b, u8, u8n);
          break;
        }
        default: goto bad;
      }
      p++;
    } else {
      buf_putn(&b, p, 1);
      p++;
    }
  }
  if (p >= end) goto bad;
  if (!b.p) { b.p = calloc(1, 1); }
  *out = b.p;
  return p + 1;
bad:
  free(b.p);
  return NULL;
}

/* Skip any JSON value; returns pointer past it or NULL. */
static const char *js_skip(const char *p, const char *end) {
  while (p < end && (*p == ' ' || *p == '\t')) p++;
  if (p >= end) return NULL;
  if (*p == '"') {
    char *tmp = NULL;
    const char *q = js_string(p, end, &tmp);
    free(tmp);
    return q;
  }
  if (*p == '{' || *p == '[') {
    char open = *p, close = open == '{' ? '}' : ']';
    p++;
    while (p < end) {
      while (p < end && (*p == ' ' || *p == '\t' || *p == ',')) p++;
      if (p >= end) return NULL;
      if (*p == close) return p + 1;
      if (open == '{' && *p == '"') {
        char *tmp = NULL;
        p = js_string(p, end, &tmp);
        free(tmp);
        if (!p) return NULL;
        while (p < end && (*p == ' ' || *p == '\t' || *p == ':')) p++;
      }
      p = js_skip(p, end);
      if (!p) return NULL;
    }
    return NULL;
  }
  while (p < end && strchr("-+0123456789.eEtruefalsn", *p)) p++;
  return p;
}

/* Iterate an object's top-level members, calling cb(key, value_start). */
static int js_object(const char *p, const char *end,
                     void (*cb)(const char *key, const char *val, const char *end, void *u),
                     void *u) {
  js j = {p, end};
  js_ws(&j);
  if (j.p >= j.end || *j.p != '{') return -1;
  j.p++;
  for (;;) {
    js_ws(&j);
    if (j.p >= j.end) return -1;
    if (*j.p == '}') return 0;
    char *key = NULL;
    j.p = js_string(j.p, j.end, &key);
    if (!j.p) { free(key); return -1; }
    js_ws(&j);
    if (j.p >= j.end || *j.p != ':') { free(key); return -1; }
    j.p++;
    js_ws(&j);
    const char *vstart = j.p;
    j.p = js_skip(j.p, j.end);
    if (!j.p) { free(key); return -1; }
    cb(key, vstart, j.p, u);
    free(key);
    js_ws(&j);
    if (j.p < j.end && *j.p == ',') { j.p++; continue; }
    if (j.p < j.end && *j.p == '}') return 0;
    return -1;
  }
}

static long js_number(const char *p, const char *end) {
  char tmp[32];
  size_t n = (size_t)(end - p);
  while (n && (p[0] == ' ' || p[0] == '\t')) { p++; n--; }
  if (n >= sizeof tmp) n = sizeof tmp - 1;
  memcpy(tmp, p, n); tmp[n] = 0;
  return strtol(tmp, NULL, 10);
}

/* ---------- request ---------- */

typedef struct {
  uint64_t id;
  char *path;
  char *argv_raw;  /* raw "args" object text — module parses k=v pairs */
  char *input;
  char *cwd;
  char *expected_sha256;
  uint64_t mem_bytes;
  uint64_t output_bytes;
} host_req;

static char *js_strval(const char *v, const char *vend) {
  if ((size_t)(vend - v) >= 4 && memcmp(v, "null", 4) == 0) return NULL;
  char *s = NULL;
  if (!js_string(v, vend, &s)) return NULL;
  return s;
}

static void req_field(const char *key, const char *v, const char *vend, void *u) {
  host_req *r = u;
  if (!strcmp(key, "id")) r->id = (uint64_t)js_number(v, vend);
  else if (!strcmp(key, "path")) r->path = js_strval(v, vend);
  else if (!strcmp(key, "input")) r->input = js_strval(v, vend);
  else if (!strcmp(key, "cwd")) r->cwd = js_strval(v, vend);
  else if (!strcmp(key, "expected_sha256")) r->expected_sha256 = js_strval(v, vend);
  else if (!strcmp(key, "args")) r->argv_raw = strndup(v, (size_t)(vend - v));
  else if (!strcmp(key, "limits")) {
    /* nested object: memBytes, outputBytes */
    typedef struct { host_req *r; } L;
    struct lim { host_req *r; } lim = {r};
    void lf(const char *k, const char *vv, const char *ve, void *uu) {
      struct lim *l = uu;
      if (!strcmp(k, "mem_bytes") || !strcmp(k, "memBytes"))
        l->r->mem_bytes = (uint64_t)js_number(vv, ve);
      else if (!strcmp(k, "output_bytes") || !strcmp(k, "outputBytes"))
        l->r->output_bytes = (uint64_t)js_number(vv, ve);
    }
    js_object(v, vend, lf, &lim);
  }
}

/* args object {k: v} -> argv "k=v" pairs */
typedef struct { char **argv; int argc, cap; } argv_build;

static void argv_pair(const char *key, const char *v, const char *vend, void *u) {
  argv_build *ab = u;
  char *vs = js_strval(v, vend);
  if (!vs) vs = strndup(v, (size_t)(vend - v));  /* numbers/bools pass raw */
  size_t n = strlen(key) + 1 + strlen(vs) + 1;
  char *pair = malloc(n);
  snprintf(pair, n, "%s=%s", key, vs);
  free(vs);
  if (ab->argc == ab->cap) {
    ab->cap = ab->cap ? ab->cap * 2 : 8;
    ab->argv = realloc(ab->argv, (size_t)ab->cap * sizeof(char *));
  }
  ab->argv[ab->argc++] = pair;
}

/* ---------- fd capture ---------- */

typedef struct { int saved_out, saved_err, rd; } fd_cap;

static int cap_begin(fd_cap *c) {
  int pfd[2];
  if (pipe(pfd) < 0) return -1;
  c->saved_out = dup(STDOUT_FILENO);
  c->saved_err = dup(STDERR_FILENO);
  c->rd = pfd[0];
  fcntl(pfd[0], F_SETFL, O_NONBLOCK);
  dup2(pfd[1], STDOUT_FILENO);
  dup2(pfd[1], STDERR_FILENO);
  close(pfd[1]);
  return 0;
}

static void cap_end(fd_cap *c, buf *out) {
  fflush(stdout);
  fflush(stderr);
  dup2(c->saved_out, STDOUT_FILENO);
  dup2(c->saved_err, STDERR_FILENO);
  close(c->saved_out);
  close(c->saved_err);
  char tmp[8192];
  ssize_t n;
  while ((n = read(c->rd, tmp, sizeof tmp)) > 0) buf_putn(out, tmp, (size_t)n);
  close(c->rd);
}

/* ---------- cwd file diff ---------- */

typedef struct { char **names; int n, cap; } dirset;

static void dir_snap(dirset *s, const char *cwd) {
  memset(s, 0, sizeof *s);
  if (!cwd) return;
  DIR *d = opendir(cwd);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    if (s->n == s->cap) {
      s->cap = s->cap ? s->cap * 2 : 16;
      s->names = realloc(s->names, (size_t)s->cap * sizeof(char *));
    }
    s->names[s->n++] = strdup(e->d_name);
  }
  closedir(d);
}

static int name_in(dirset *s, const char *n) {
  for (int i = 0; i < s->n; i++) if (!strcmp(s->names[i], n)) return 1;
  return 0;
}

static void dir_free(dirset *s) {
  for (int i = 0; i < s->n; i++) free(s->names[i]);
  free(s->names);
}

/* ---------- response ---------- */

static const char *outcome_str(cz_outcome o) {
  switch (o) {
    case CZ_OK: return "ok";
    case CZ_ERROR: return "error";
    case CZ_INTERRUPTED: return "interrupted";
    case CZ_TIMEOUT: return "timeout";
    case CZ_SOURCE_MISSING: return "source_missing";
    case CZ_CONTENT_CHANGED: return "content_changed";
    default: return "host_fault";
  }
}

static void emit_response(FILE *out, const host_req *r, cz_result *res,
                          const buf *fd_text, int truncated,
                          const dirset *after, const dirset *before,
                          long duration_ms) {
  buf b = {0};
  char num[32];
  buf_puts(&b, "{\"id\":");
  snprintf(num, sizeof num, "%llu", (unsigned long long)r->id);
  buf_puts(&b, num);
  buf_puts(&b, ",\"outcome\":");
  buf_json_str(&b, res ? outcome_str(g_mod.r_outcome(res)) : "host_fault");

  if (res) {
    const char *v = g_mod.r_value(res);
    if (v) { buf_puts(&b, ",\"value\":"); buf_json_str(&b, v); }
    const char *et = g_mod.r_error_type(res);
    if (et) {
      buf_puts(&b, ",\"error\":{\"type\":");
      buf_json_str(&b, et);
      buf_puts(&b, ",\"message\":");
      buf_json_str(&b, g_mod.r_error_message(res));
      const char *tb = g_mod.r_error_traceback(res);
      if (tb) { buf_puts(&b, ",\"traceback\":"); buf_json_str(&b, tb); }
      const char *ef = g_mod.r_error_file(res);
      if (ef) { buf_puts(&b, ",\"file\":"); buf_json_str(&b, ef); }
      long el = g_mod.r_error_line(res);
      if (el > 0) {
        buf_puts(&b, ",\"line\":");
        snprintf(num, sizeof num, "%ld", el);
        buf_puts(&b, num);
      }
      buf_puts(&b, "}");
    }
    /* in-language capture + fd-level capture merged */
    const char *so = g_mod.r_stdout(res);
    const char *se = g_mod.r_stderr(res);
    buf_puts(&b, ",\"stdout\":");
    buf_json_str(&b, so ? so : "");
    buf_puts(&b, ",\"stderr\":");
    buf_json_str(&b, se ? se : "");
  }

  /* files = names in `after` not in `before` */
  buf_puts(&b, ",\"files\":[");
  int first = 1;
  for (int i = 0; i < after->n; i++) {
    if (!name_in((dirset *)before, after->names[i])) {
      if (!first) buf_puts(&b, ",");
      buf_json_str(&b, after->names[i]);
      first = 0;
    }
  }
  buf_puts(&b, "]");

  if (fd_text && fd_text->n) {
    buf_puts(&b, ",\"fdOutput\":");
    buf_json_str(&b, fd_text->p);
  }
  if (truncated) buf_puts(&b, ",\"truncated\":true");
  if (res) {
    const char *sha = g_mod.r_content_sha256(res);
    if (sha) { buf_puts(&b, ",\"content_sha256\":"); buf_json_str(&b, sha); }
  }
  if (res && g_mod.r_duration_ms(res) >= 0)
    duration_ms = g_mod.r_duration_ms(res);
  buf_puts(&b, ",\"duration_ms\":");
  snprintf(num, sizeof num, "%ld", duration_ms);
  buf_puts(&b, num);
  buf_puts(&b, "}\n");
  fwrite(b.p, 1, b.n, out);
  fflush(out);
  free(b.p);
}

static void emit_error_line(FILE *out, uint64_t id, const char *outcome,
                            const char *type, const char *msg) {
  buf b = {0};
  char num[32];
  buf_puts(&b, "{\"id\":");
  snprintf(num, sizeof num, "%llu", (unsigned long long)id);
  buf_puts(&b, num);
  buf_puts(&b, ",\"outcome\":");
  buf_json_str(&b, outcome);
  buf_puts(&b, ",\"error\":{\"type\":");
  buf_json_str(&b, type);
  buf_puts(&b, ",\"message\":");
  buf_json_str(&b, msg);
  buf_puts(&b, "}}\n");
  fwrite(b.p, 1, b.n, out);
  fflush(out);
  free(b.p);
}

/* ---------- run dispatch ---------- */

static void handle_run(FILE *out, host_req *r) {
  cz_request req = {0};
  req.path = r->path;
  req.input = r->input;
  req.cwd = r->cwd;
  req.expected_sha256 = r->expected_sha256;
  req.mem_bytes = r->mem_bytes;
  req.output_bytes = r->output_bytes;

  argv_build ab = {0};
  if (r->argv_raw) {
    js_object(r->argv_raw, r->argv_raw + strlen(r->argv_raw), argv_pair, &ab);
    req.argv = (const char *const *)ab.argv;
    req.argc = ab.argc;
  }

  dirset before, after;
  dir_snap(&before, r->cwd);

  fd_cap cap;
  int capped = cap_begin(&cap) == 0;

  struct rlimit prev_as;
  int had_limit = 0;
  if (r->mem_bytes && getrlimit(RLIMIT_AS, &prev_as) == 0) {
    struct rlimit rl = {r->mem_bytes, prev_as.rlim_max};
    if (setrlimit(RLIMIT_AS, &rl) == 0) had_limit = 1;
  }

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  cz_result *res = NULL;
  if (g_mod.run_file(g_ctx, &req, &res) != 0) res = NULL;
  clock_gettime(CLOCK_MONOTONIC, &t1);
  long dur = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000;

  if (had_limit) setrlimit(RLIMIT_AS, &prev_as);

  buf fd_text = {0};
  if (capped) cap_end(&cap, &fd_text);

  dir_snap(&after, r->cwd);

  int truncated = 0;
  if (r->output_bytes && res) {
    const char *so = g_mod.r_stdout(res), *se = g_mod.r_stderr(res);
    if ((so ? strlen(so) : 0) + (se ? strlen(se) : 0) + fd_text.n > r->output_bytes)
      truncated = 1;
  }
  if (r->output_bytes && fd_text.n > r->output_bytes) {
    fd_text.n = r->output_bytes;
    fd_text.p[fd_text.n] = 0;
    truncated = 1;
  }

  emit_response(out, r, res, &fd_text, truncated, &after, &before, dur);
  if (res) g_mod.r_free(res);
  dir_free(&before);
  dir_free(&after);
  free(fd_text.p);
  for (int i = 0; i < ab.argc; i++) free(ab.argv[i]);
  free(ab.argv);
}

/* ---------- main ---------- */

int main(int argc, char **argv) {
  const char *mod_path = NULL, *interpreter = NULL, *lib = NULL;
  const char *language = NULL;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--module")) mod_path = argv[i + 1];
    else if (!strcmp(argv[i], "--interpreter")) interpreter = argv[i + 1];
    else if (!strcmp(argv[i], "--lib")) lib = argv[i + 1];
    else if (!strcmp(argv[i], "--language")) language = argv[i + 1];
  }
  if (!mod_path) {
    fprintf(stderr, "cz-host: --module <path> required\n");
    return 2;
  }

  setvbuf(stdout, NULL, _IOLBF, 0);

  setsid();  /* own process group — kill(-pgid) reaches interpreter children */
#ifdef __linux__
  prctl(PR_SET_PDEATHSIG, SIGKILL);  /* die with the supervisor */
#endif

  char err[512];
  if (load_module(mod_path, &g_mod, err, sizeof err) < 0) {
    fprintf(stderr, "cz-host: %s\n", err);
    return 3;
  }

  cz_config cfg = {0};
  cfg.language = language;
  cfg.interpreter = interpreter;
  cfg.lib_path = lib;

  g_ctx = g_mod.open(&cfg);
  if (!g_ctx) {
    fprintf(stderr, "cz-host: module %s failed to open\n", mod_path);
    return 4;
  }

  struct sigaction sa = {0};
  sa.sa_handler = on_sigint;
  sigaction(SIGINT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);

  /* ready line — supervisor validates protocol + abi + language */
  {
    buf b = {0};
    buf_puts(&b, "{\"protocol\":1,\"abi\":");
    char num[16];
    snprintf(num, sizeof num, "%u", g_mod.abi_version());
    buf_puts(&b, num);
    buf_puts(&b, ",\"language\":");
    buf_json_str(&b, language ? language : "");
    buf_puts(&b, ",\"ready\":true}\n");
    fputs(b.p, stdout);
    fflush(stdout);
    free(b.p);
  }

  /* NDJSON loop — one request per line */
  buf line = {0};
  char chunk[8192];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, chunk, sizeof chunk);
    if (n <= 0) break;  /* stdin closed => supervisor gone */
    for (ssize_t i = 0; i < n; i++) {
      if (chunk[i] != '\n') { buf_putn(&line, &chunk[i], 1); continue; }
      host_req r = {0};
      if (line.n &&
          js_object(line.p, line.p + line.n, req_field, &r) == 0 &&
          r.path) {
        handle_run(stdout, &r);
      } else {
        emit_error_line(stdout, r.id, "error", "Protocol",
                        "malformed request");
      }
      free(r.path); free(r.argv_raw); free(r.input);
      free(r.cwd); free(r.expected_sha256);
      line.n = 0;
      if (line.p) line.p[0] = 0;
    }
  }

  g_mod.close(g_ctx);
  dlclose(g_mod.handle);
  return 0;
}
