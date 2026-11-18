/* libcz_r — cz-host module embedding R via libR (feature 028, US4).
 *
 * Built only when R headers + libR are found (see CMakeLists). Rf_initEmbeddedR
 * runs on the host's main thread with R signal handlers disabled so the
 * supervisor owns SIGINT/SIGTERM. Scripts execute via
 * source(path, keep.source=TRUE) inside tryCatch/withCallingHandlers —
 * errors surface the last srcref filename/line. No jsonlite: requests and
 * results are marshalled through plain R lists; JSON stays in cz-host.
 *
 * Fingerprint is done in C here (readBin + sha256.c) because base R has no
 * SHA-256 — the module still hashes the exact file bytes before sourcing.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <R.h>
#include <Rinternals.h>
#include <Rinterface.h>
#include <Rembedded.h>
#include <R_ext/Parse.h>

/* not exported by the public headers on every R version */
extern Rboolean R_interrupts_pending;
extern uintptr_t R_CStackLimit;

#include "../cz_script.h"
#include "sha256.h"

struct cz_ctx { int dummy; };

struct cz_result {
  cz_outcome outcome;
  long duration_ms;
  char *value;
  char *err_type, *err_msg, *err_tb, *err_file;
  long err_line;
  char *out, *err, *sha;
};

static char *dupz(const char *s) { return s ? strdup(s) : NULL; }

static const char *str_elt(SEXP x, int i) {
  if (TYPEOF(x) != STRSXP || i >= (int)XLENGTH(x)) return NULL;
  SEXP s = STRING_ELT(x, i);
  return s == NA_STRING ? NULL : CHAR(s);
}

/* find field `name` in a named VECSXP; returns its element or NULL */
static SEXP field(SEXP list, const char *name) {
  if (TYPEOF(list) != VECSXP) return NULL;
  SEXP nm = getAttrib(list, R_NamesSymbol);
  if (TYPEOF(nm) != STRSXP) return NULL;
  for (int i = 0; i < (int)XLENGTH(list); i++) {
    const char *k = str_elt(nm, i);
    if (k && !strcmp(k, name)) return VECTOR_ELT(list, i);
  }
  return NULL;
}

static char *field_str(SEXP list, const char *name) {
  SEXP v = field(list, name);
  return dupz(str_elt(v, 0));
}

/* ---------- session bootstrap (evaluated once at cz_open) ---------- */

static const char *R_BOOTSTRAP =
".cz_env <- new.env(parent = globalenv())\n"
".cz_run <- function(path, argv, input, cwd) {\n"
"  args <- list()\n"
"  for (pair in argv) {\n"
"    i <- regexpr('=', pair, fixed = TRUE)[1]\n"
"    if (i > 0) {\n"
"      k <- substr(pair, 1, i - 1); v <- substring(pair, i + 1)\n"
"      num <- suppressWarnings(as.numeric(v))\n"
"      if (!is.na(num)) v <- num\n"
"      else if (v %in% c('TRUE','FALSE')) v <- as.logical(v)\n"
"      args[[k]] <- v\n"
"    }\n"
"  }\n"
"  assign('ARGS', args, envir = .cz_env)\n"
"  assign('INPUT', input, envir = .cz_env)\n"
"  for (k in names(args)) if (nzchar(k) && k == make.names(k))\n"
"    assign(k, args[[k]], envir = .cz_env)\n"
"  if (!is.null(cwd) && nzchar(cwd)) {\n"
"    dir.create(cwd, showWarnings = FALSE, recursive = TRUE)\n"
"    setwd(cwd)\n"
"  }\n"
"  .cz_out <- character(); .cz_err <- character()\n"
"  scon <- textConnection('.cz_out_sink', 'w', local = TRUE)\n"
"  econ <- textConnection('.cz_err_sink', 'w', local = TRUE)\n"
"  sink(scon); sink(econ, type = 'message')\n"
"  last_sr <- NULL; err_info <- NULL\n"
"  outcome <- 'ok'\n"
"  val <- withCallingHandlers(tryCatch({\n"
"      source(path, local = .cz_env, keep.source = TRUE)$value\n"
"    }, error = function(e) {\n"
"      err_info <<- e\n"
"      outcome <<- 'error'\n"
"      calls <- sys.calls()\n"
"      for (i in seq_along(calls)) {\n"
"        sr <- attr(calls[[i]], 'srcref')\n"
"        if (!is.null(sr)) last_sr <<- sr\n"
"      }\n"
"      NULL\n"
"    }),\n"
"    message = function(m) { cat(conditionMessage(m), file = econ)\n"
"                            invokeRestart('muffleMessage') },\n"
"    warning = function(w) { cat(paste0('Warning: ', conditionMessage(w)),\n"
"                            file = econ); invokeRestart('muffleWarning') },\n"
"    interrupt = function(i) { outcome <<- 'interrupted'\n"
"                              invokeRestart('abort') })\n"
"  sink(type = 'message'); sink()\n"
"  close(econ); close(scon)\n"
"  res <- list(outcome = outcome,\n"
"              value = if (is.null(val)) '' else capture.output(str(val)),\n"
"              stdout = paste(.cz_out_sink, collapse = '\\n'),\n"
"              stderr = paste(.cz_err_sink, collapse = '\\n'),\n"
"              err_type = '', err_msg = '', err_file = '', err_line = -1)\n"
"  res$value <- res$value[1]\n"
"  if (!is.null(err_info)) {\n"
"    res$err_type <- class(err_info)[1]\n"
"    res$err_msg <- conditionMessage(err_info)\n"
"    if (!is.null(last_sr)) {\n"
"      sf <- attr(last_sr, 'srcfile')\n"
"      if (!is.null(sf)) res$err_file <- sf$filename\n"
"      res$err_line <- as.integer(last_sr[[1]])\n"
"    }\n"
"  }\n"
"  res\n"
"}\n";

/* ---------- module ABI ---------- */

int cz_abi_version(void) { return CZ_ABI_VERSION; }

static cz_outcome outcome_of(const char *s) {
  if (!s) return CZ_HOST_FAULT;
  if (!strcmp(s, "ok")) return CZ_OK;
  if (!strcmp(s, "error")) return CZ_ERROR;
  if (!strcmp(s, "interrupted")) return CZ_INTERRUPTED;
  if (!strcmp(s, "timeout")) return CZ_TIMEOUT;
  if (!strcmp(s, "source_missing")) return CZ_SOURCE_MISSING;
  if (!strcmp(s, "content_changed")) return CZ_CONTENT_CHANGED;
  return CZ_HOST_FAULT;
}

cz_ctx *cz_open(const cz_config *cfg) {
  char *argv[4];
  int argc = 0;
  argv[argc++] = (char *)"cz-host";
  argv[argc++] = (char *)"--quiet";
  argv[argc++] = (char *)"--no-save";
  argv[argc++] = (char *)"--no-restore";

  /* embedded R needs R_HOME — derive <libdir>/.. from lib_path when unset */
  if (!getenv("R_HOME") && cfg && cfg->lib_path) {
    char tmp[1024];
    snprintf(tmp, sizeof tmp, "%s", cfg->lib_path);
    char *slash = strrchr(tmp, '/');      /* strip libR.so */
    if (slash) *slash = 0;
    slash = strrchr(tmp, '/');            /* strip lib/ */
    if (slash) { *slash = 0; setenv("R_HOME", tmp, 0); }
  }

  R_SignalHandlers = 0;  /* supervisor owns signal policy */
  int ok = Rf_initEmbeddedR(argc, argv);  /* returns 1 on success */
  if (ok != 1) {
    fprintf(stderr, "libcz_r: Rf_initEmbeddedR failed\n");
    return NULL;
  }
  (void)cfg;
  R_CStackLimit = (uintptr_t)-1;  /* cz-host is already supervised */

  ParseStatus pstatus;
  SEXP boot = PROTECT(R_ParseVector(mkString(R_BOOTSTRAP), -1, &pstatus,
                                    R_NilValue));
  if (pstatus != PARSE_OK) {
    UNPROTECT(1);
    fprintf(stderr, "libcz_r: bootstrap parse failed\n");
    return NULL;
  }
  int estat;
  for (int i = 0; i < (int)XLENGTH(boot); i++)
    R_tryEval(VECTOR_ELT(boot, i), R_GlobalEnv, &estat);
  UNPROTECT(1);

  cz_ctx *c = calloc(1, sizeof *c);
  return c;
}

void cz_close(cz_ctx *c) {
  if (!c) return;
  Rf_endEmbeddedR(0);
  free(c);
}

static void read_file(const char *path, unsigned char **data, size_t *n) {
  *data = NULL; *n = 0;
  FILE *f = fopen(path, "rb");
  if (!f) return;
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (sz < 0) { fclose(f); return; }
  *data = malloc((size_t)sz + 1);
  *n = fread(*data, 1, (size_t)sz, f);
  (*data)[*n] = 0;
  fclose(f);
}

int cz_run_file(cz_ctx *c, const cz_request *req, cz_result **out) {
  cz_result *r = calloc(1, sizeof *r);
  if (!r) return 1;
  *out = r;
  r->err_line = -1;
  r->outcome = CZ_HOST_FAULT;
  r->duration_ms = -1;
  (void)c;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  /* exact-byte fingerprint before anything runs */
  unsigned char *bytes = NULL;
  size_t n = 0;
  read_file(req->path, &bytes, &n);
  if (!bytes) {
    r->outcome = CZ_SOURCE_MISSING;
    r->err_type = dupz("SourceMissing");
    r->err_msg = dupz(req->path);
    goto done;
  }
  char sha[65];
  cz_sha256_hex(bytes, n, sha);
  free(bytes);
  r->sha = dupz(sha);
  if (req->expected_sha256 && strcmp(req->expected_sha256, sha) != 0) {
    r->outcome = CZ_CONTENT_CHANGED;
    r->err_type = dupz("ContentChanged");
    r->err_msg = dupz(req->path);
    goto done;
  }

  /* build .cz_run(path, argv, input, cwd) */
  SEXP argvv = PROTECT(allocVector(STRSXP, req->argc));
  for (int i = 0; i < req->argc; i++)
    SET_STRING_ELT(argvv, i, mkChar(req->argv[i]));
  SEXP call = PROTECT(lang5(Rf_install(".cz_run"),
                            mkString(req->path), argvv,
                            req->input ? mkString(req->input) : mkString(""),
                            req->cwd ? mkString(req->cwd) : mkString("")));
  int estatus;
  SEXP res = PROTECT(R_tryEval(call, R_GlobalEnv, &estatus));
  if (estatus || TYPEOF(res) != VECSXP) {
    r->err_type = dupz("HostFault");
    r->err_msg = dupz("R evaluation fault");
    UNPROTECT(3);
    goto done;
  }

  {
    char *os = field_str(res, "outcome");
    r->outcome = outcome_of(os);
    free(os);
  }
  r->value = field_str(res, "value");
  r->out = field_str(res, "stdout");
  r->err = field_str(res, "stderr");
  r->err_type = field_str(res, "err_type");
  r->err_msg = field_str(res, "err_msg");
  r->err_file = field_str(res, "err_file");
  {
    SEXP el = field(res, "err_line");
    if (el) r->err_line = asInteger(el);
  }
  /* empty-string optionals -> NULL so the host omits them */
  if (r->value && !*r->value) { free(r->value); r->value = NULL; }
  if (r->err_type && !*r->err_type) { free(r->err_type); r->err_type = NULL; }
  if (r->err_msg && !*r->err_msg) { free(r->err_msg); r->err_msg = NULL; }
  if (r->err_file && !*r->err_file) { free(r->err_file); r->err_file = NULL; }
  UNPROTECT(3);
done:
  clock_gettime(CLOCK_MONOTONIC, &t1);
  r->duration_ms = (t1.tv_sec - t0.tv_sec) * 1000 +
                   (t1.tv_nsec - t0.tv_nsec) / 1000000;
  return 0;
}

void cz_interrupt(cz_ctx *c) {
  (void)c;
  R_interrupts_pending = TRUE;  /* next R_CheckUserInterrupt fires */
}

cz_outcome cz_result_outcome(const cz_result *r) { return r->outcome; }
const char *cz_result_value(const cz_result *r) { return r->value; }
const char *cz_result_error_type(const cz_result *r) { return r->err_type; }
const char *cz_result_error_message(const cz_result *r) { return r->err_msg; }
const char *cz_result_error_traceback(const cz_result *r) { return r->err_tb; }
const char *cz_result_error_file(const cz_result *r) { return r->err_file; }
long cz_result_error_line(const cz_result *r) { return r->err_line; }
const char *cz_result_stdout(const cz_result *r) { return r->out; }
const char *cz_result_stderr(const cz_result *r) { return r->err; }
const char *cz_result_content_sha256(const cz_result *r) { return r->sha; }
long cz_result_duration_ms(const cz_result *r) { return r->duration_ms; }

void cz_result_free(cz_result *r) {
  if (!r) return;
  free(r->value);
  free(r->err_type); free(r->err_msg); free(r->err_tb); free(r->err_file);
  free(r->out); free(r->err); free(r->sha);
  free(r);
}
