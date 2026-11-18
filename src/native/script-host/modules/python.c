/* libcz_python — cz-host module embedding CPython 3.14+ without Python.h.
 *
 * libpython is dlopen'ed from cfg->library (probed by the supervisor via
 * sysconfig LIBDIR/INSTSONAME) and every CPython entry point we need is
 * resolved with dlsym — no Python headers or link-time dependency.
 *
 * Execution model (mirrors the previous subprocess runner):
 *   - persistent namespace `_ns` IS the session
 *   - ARGS dict + one binding per arg key; INPUT bound for paramless runs
 *   - compile(source, path, 'exec') keeps the real filename in tracebacks
 *   - script dir goes on sys.path; __file__ set during the run
 *   - trailing bare expression evals to `result`; else `_result` var
 *   - stdout/stderr captured in-language; structured error fields returned
 *
 * Fingerprint: the file bytes are read and hashed (hashlib.sha256) inside
 * the module before every run; mismatch => CZ_CONTENT_CHANGED without
 * executing, unreadable path => CZ_SOURCE_MISSING (FR-004/FR-006).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../cz_script.h"

/* ---- minimal CPython declarations (PEP 741 init config, 3.13+) ---- */

typedef struct PyInitConfig PyInitConfig;
typedef struct PyObject PyObject;
typedef struct { int exitcode; const char *err_msg; const char *func; } CzPyStatus;

typedef struct {
  void *h;
  PyInitConfig *(*InitConfig_Create)(void);
  int (*InitConfig_SetStr)(PyInitConfig *, const char *, const char *);
  int (*InitConfig_SetInt)(PyInitConfig *, const char *, int64_t);
  void (*InitConfig_Free)(PyInitConfig *);
  CzPyStatus (*InitializeFromInitConfig)(PyInitConfig *);
  void (*Initialize)(void);
  int (*FinalizeEx)(void);
  int (*Run_SimpleStringFlags)(const char *, void *);
  PyObject *(*Run_StringFlags)(const char *, int, PyObject *, PyObject *, void *);
  PyObject *(*Import_AddModule)(const char *);
  PyObject *(*Module_GetDict)(PyObject *);
  PyObject *(*Dict_GetItemString)(PyObject *, const char *);
  int (*Dict_SetItemString)(PyObject *, const char *, PyObject *);
  PyObject *(*Dict_New)(void);
  PyObject *(*List_New)(long);
  int (*List_Append)(PyObject *, PyObject *);
  PyObject *(*Unicode_FromString)(const char *);
  const char *(*Unicode_AsUTF8)(PyObject *);
  long (*Long_AsLong)(PyObject *);
  void (*DecRef)(PyObject *);
  void (*Err_Clear)(void);
  void (*Err_Fetch)(PyObject **, PyObject **, PyObject **);
  void (*Err_NormalizeException)(PyObject **, PyObject **, PyObject **);
  PyObject *(*Object_Str)(PyObject *);
  int (*Err_SetInterrupt)(int);
} py_api;

#define PY_EVAL_INPUT 258

struct cz_ctx {
  py_api py;
  PyObject *main_dict;  /* borrowed — owns _ns/_cz_call/_cz_req/_cz_out */
};

struct cz_result {
  cz_outcome outcome;
  long duration_ms;
  char *value;
  char *err_type, *err_msg, *err_tb, *err_file;
  long err_line;
  char *out, *err, *sha;
};

static char *dupz(const char *s) { return s ? strdup(s) : NULL; }

/* ---- dlopen libpython ---- */

static int py_load(py_api *py, const char *libpath, char *err, size_t errn) {
  static const char *fallback[] = {
    "libpython3.14.so.1.0", "libpython3.14.so",
    "libpython3.13.so.1.0", "libpython3.13.so", NULL,
  };
  void *h = NULL;
  if (libpath) {
    h = dlopen(libpath, RTLD_NOW | RTLD_GLOBAL);
    if (!h) { snprintf(err, errn, "dlopen %s: %s", libpath, dlerror()); return -1; }
  } else {
    for (int i = 0; fallback[i] && !h; i++)
      h = dlopen(fallback[i], RTLD_NOW | RTLD_GLOBAL);
    if (!h) { snprintf(err, errn, "no libpython found (probe sysconfig first)"); return -1; }
  }
  py->h = h;
#define PSYM(f, n)                                                   \
  py->f = dlsym(h, n);                                               \
  if (!py->f) { snprintf(err, errn, "libpython: missing %s", n); return -1; }
  PSYM(InitConfig_Create, "PyInitConfig_Create")
  PSYM(InitConfig_SetStr, "PyInitConfig_SetStr")
  PSYM(InitConfig_SetInt, "PyInitConfig_SetInt")
  PSYM(InitConfig_Free, "PyInitConfig_Free")
  PSYM(InitializeFromInitConfig, "Py_InitializeFromInitConfig")
  PSYM(Initialize, "Py_Initialize")
  PSYM(FinalizeEx, "Py_FinalizeEx")
  PSYM(Run_SimpleStringFlags, "PyRun_SimpleStringFlags")
  PSYM(Run_StringFlags, "PyRun_StringFlags")
  PSYM(Import_AddModule, "PyImport_AddModule")
  PSYM(Module_GetDict, "PyModule_GetDict")
  PSYM(Dict_GetItemString, "PyDict_GetItemString")
  PSYM(Dict_SetItemString, "PyDict_SetItemString")
  PSYM(Dict_New, "PyDict_New")
  PSYM(List_New, "PyList_New")
  PSYM(List_Append, "PyList_Append")
  PSYM(Unicode_FromString, "PyUnicode_FromString")
  PSYM(Unicode_AsUTF8, "PyUnicode_AsUTF8")
  PSYM(Long_AsLong, "PyLong_AsLong")
  PSYM(DecRef, "Py_DecRef")
  PSYM(Err_Clear, "PyErr_Clear")
  PSYM(Err_Fetch, "PyErr_Fetch")
  PSYM(Err_NormalizeException, "PyErr_NormalizeException")
  PSYM(Object_Str, "PyObject_Str")
  PSYM(Err_SetInterrupt, "PyErr_SetInterrupt")
#undef PSYM
  return 0;
}

/* ---- session bootstrap (runs once inside the interpreter) ---- */

static const char *BOOTSTRAP =
"import ast, contextlib, hashlib, io, json, os, sys, traceback\n"
"_ns = {'__name__': '__causerie_session__'}\n"
"def _cz_call(req):\n"
"    try:\n"
"        return _cz_impl(req)\n"
"    except BaseException:\n"
"        exc = sys.exc_info()[1]\n"
"        return {'outcome':'error','content_sha256':None,'value':None,\n"
"                'stdout':'','stderr':'','error':{'type':type(exc).__name__,\n"
"                'message':str(exc),'traceback':''.join(traceback.format_exception(exc))}}\n"
"def _cz_impl(req):\n"
"    args = {}\n"
"    for pair in req.get('argv') or []:\n"
"        k, _, v = pair.partition('=')\n"
"        try: args[k] = json.loads(v)\n"
"        except Exception: args[k] = v\n"
"    _ns['ARGS'] = args\n"
"    _ns['INPUT'] = req.get('input')\n"
"    for k, v in args.items():\n"
"        if isinstance(k, str) and k.isidentifier():\n"
"            _ns[k] = v\n"
"    cwd = req.get('cwd')\n"
"    if cwd:\n"
"        os.makedirs(cwd, exist_ok=True)\n"
"        os.chdir(cwd)\n"
"    path = req['path']\n"
"    try:\n"
"        data = open(path, 'rb').read()\n"
"    except OSError:\n"
"        return {'outcome':'source_missing','content_sha256':None,\n"
"                'stdout':'','stderr':'','value':None,'error':{\n"
"                'type':'SourceMissing','message':path}}\n"
"    sha = hashlib.sha256(data).hexdigest()\n"
"    exp = req.get('expected_sha256')\n"
"    if exp and exp != sha:\n"
"        return {'outcome':'content_changed','content_sha256':sha,\n"
"                'stdout':'','stderr':'','value':None,'error':{\n"
"                'type':'ContentChanged','message':path}}\n"
"    try:\n"
"        src = data.decode('utf-8')\n"
"    except UnicodeDecodeError as e:\n"
"        return {'outcome':'error','content_sha256':sha,\n"
"                'stdout':'','stderr':'','value':None,'error':{\n"
"                'type':'UnicodeDecodeError','message':str(e)}}\n"
"    out, err = io.StringIO(), io.StringIO()\n"
"    sdir = os.path.dirname(os.path.abspath(path))\n"
"    added = sdir not in sys.path\n"
"    if added: sys.path.insert(0, sdir)\n"
"    _ns['__file__'] = path\n"
"    value, outcome, error = None, 'ok', None\n"
"    try:\n"
"        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):\n"
"            tree = ast.parse(src, filename=path)\n"
"            if tree.body and isinstance(tree.body[-1], ast.Expr):\n"
"                last = tree.body.pop()\n"
"                exec(compile(tree, path, 'exec'), _ns)\n"
"                value = eval(compile(ast.Expression(last.value), path, 'eval'), _ns)\n"
"            else:\n"
"                exec(compile(tree, path, 'exec'), _ns)\n"
"                value = _ns.get('_result')\n"
"    except KeyboardInterrupt:\n"
"        outcome, error = 'interrupted', {'type':'KeyboardInterrupt','message':'interrupted'}\n"
"    except SystemExit as e:\n"
"        outcome, error = 'error', {'type':'SystemExit','message':str(e.code)}\n"
"    except BaseException as exc:\n"
"        tb = traceback.extract_tb(exc.__traceback__)\n"
"        error = {'type':type(exc).__name__,'message':str(exc),\n"
"                 'traceback':''.join(traceback.format_exception(exc))}\n"
"        if tb:\n"
"            error['file'], error['line'] = tb[-1].filename, tb[-1].lineno\n"
"        outcome = 'error'\n"
"    finally:\n"
"        if added and sdir in sys.path: sys.path.remove(sdir)\n"
"        _ns.pop('_result', None)\n"
"        _ns.pop('__file__', None)\n"
"    if value is not None:\n"
"        try: value = repr(value)\n"
"        except Exception: value = '<unrepresentable>'\n"
"    return {'outcome':outcome,'content_sha256':sha,'value':value,\n"
"            'error':error,'stdout':out.getvalue(),'stderr':err.getvalue()}\n";
/* ---- helpers to read the result dict ---- */

/* field reads must never leak a pending TypeError into the next eval —
 * Unicode_AsUTF8(non-str) sets one, so clear on every miss. */
static char *dict_str(py_api *py, PyObject *d, const char *key) {
  PyObject *v = py->Dict_GetItemString(d, key);
  if (!v) { py->Err_Clear(); return NULL; }
  const char *s = py->Unicode_AsUTF8(v);
  if (!s) { py->Err_Clear(); return NULL; }
  return dupz(s);
}

static long dict_long(py_api *py, PyObject *d, const char *key) {
  PyObject *v = py->Dict_GetItemString(d, key);
  if (!v) { py->Err_Clear(); return -1; }
  long x = py->Long_AsLong(v);
  if (x == -1) py->Err_Clear();  /* non-int field — not our error */
  return x;
}

/* ---- module ABI ---- */

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
  cz_ctx *c = calloc(1, sizeof *c);
  char err[256];
  if (py_load(&c->py, cfg ? cfg->lib_path : NULL, err, sizeof err) < 0) {
    fprintf(stderr, "libcz_python: %s\n", err);
    free(c);
    return NULL;
  }
  /* PEP 741 InitConfig is the spec'd path — but this libpython build
   * (Fedora 3.14) segfaults in PyImport_ExtendInittab during
   * Py_InitializeFromInitConfig, so the default is Py_Initialize with
   * equivalent isolation via env vars. CZ_PY_INITCONFIG=1 opts back in. */
  if (getenv("CZ_PY_INITCONFIG")) {
    PyInitConfig *ic = c->py.InitConfig_Create();
    if (!ic) { free(c); return NULL; }
    c->py.InitConfig_SetInt(ic, "isolated", 1);
    if (cfg && cfg->interpreter)
      c->py.InitConfig_SetStr(ic, "executable", cfg->interpreter);
    CzPyStatus st = c->py.InitializeFromInitConfig(ic);
    c->py.InitConfig_Free(ic);
    if (st.exitcode != 0) {
      fprintf(stderr, "libcz_python: init failed: %s\n",
              st.err_msg ? st.err_msg : "?");
      free(c);
      return NULL;
    }
  } else {
    setenv("PYTHONNOUSERSITE", "1", 1);
    setenv("PYTHONDONTWRITEBYTECODE", "1", 1);
    setenv("PYTHONSAFEPATH", "1", 1);
    c->py.Initialize();
    if (cfg && cfg->interpreter) {
      /* sys.executable hint for venv-aware scripts */
      PyObject *s = c->py.Unicode_FromString(cfg->interpreter);
      PyObject *m = c->py.Import_AddModule("sys");
      PyObject *d = m ? c->py.Module_GetDict(m) : NULL;
      if (d) c->py.Dict_SetItemString(d, "executable", s);
      c->py.DecRef(s);
    }
  }
  if (c->py.Run_SimpleStringFlags(BOOTSTRAP, NULL) != 0) {
    fprintf(stderr, "libcz_python: bootstrap failed\n");
    free(c);
    return NULL;
  }
  PyObject *m = c->py.Import_AddModule("__main__");
  c->main_dict = m ? c->py.Module_GetDict(m) : NULL;
  if (!c->main_dict) { free(c); return NULL; }
  return c;
}

void cz_close(cz_ctx *c) {
  if (!c) return;
  c->py.FinalizeEx();
  dlclose(c->py.h);
  free(c);
}

int cz_run_file(cz_ctx *c, const cz_request *req, cz_result **out) {
  py_api *py = &c->py;
  cz_result *r = calloc(1, sizeof *r);
  if (!r) return 1;
  *out = r;
  r->err_line = -1;
  r->outcome = CZ_HOST_FAULT;
  r->duration_ms = -1;
  if (!c->main_dict) return 0;

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  /* marshal the request into __main__._cz_req as a dict */
  PyObject *rd = py->Dict_New();
  {
    PyObject *s = py->Unicode_FromString(req->path);
    py->Dict_SetItemString(rd, "path", s);
    py->DecRef(s);
  }
  if (req->input) {
    PyObject *s = py->Unicode_FromString(req->input);
    py->Dict_SetItemString(rd, "input", s);
    py->DecRef(s);
  }
  if (req->cwd) {
    PyObject *s = py->Unicode_FromString(req->cwd);
    py->Dict_SetItemString(rd, "cwd", s);
    py->DecRef(s);
  }
  if (req->expected_sha256) {
    PyObject *s = py->Unicode_FromString(req->expected_sha256);
    py->Dict_SetItemString(rd, "expected_sha256", s);
    py->DecRef(s);
  }
  PyObject *av = py->List_New(0);  /* New(n) pre-fills NULL slots — append instead */
  for (int i = 0; i < req->argc; i++) {
    PyObject *s = py->Unicode_FromString(req->argv[i]);
    py->List_Append(av, s);
    py->DecRef(s);
  }
  py->Dict_SetItemString(rd, "argv", av);
  py->DecRef(av);
  py->Dict_SetItemString(c->main_dict, "_cz_req", rd);
  py->DecRef(rd);

  py->Err_Clear();  /* no pending error may enter the eval */
  PyObject *res = py->Run_StringFlags("_cz_call(_cz_req)", PY_EVAL_INPUT,
                                      c->main_dict, c->main_dict, NULL);
  if (!res) {
    /* interpreter-level fault (e.g. bootstrap broken) — fault out */
    PyObject *pt = NULL, *pv = NULL, *ptb = NULL;
    py->Err_Fetch(&pt, &pv, &ptb);
    py->Err_NormalizeException(&pt, &pv, &ptb);
    PyObject *ps = pv ? py->Object_Str(pv) : NULL;
    const char *msg = ps ? py->Unicode_AsUTF8(ps) : NULL;
    fprintf(stderr, "libcz_python: _cz_call raised: %s\n",
            msg ? msg : "(unknown)");
    void (*errprint)(void) = dlsym(c->py.h, "PyErr_Print");
    /* need PyErr_Restore first so Print sees it */
    void (*errrestore)(PyObject*,PyObject*,PyObject*) =
      dlsym(c->py.h, "PyErr_Restore");
    if (errrestore && errprint) {
      errrestore(pt, pv, ptb); pt = pv = ptb = NULL;
      errprint();
    }
    r->err_type = dupz("HostFault");
    r->err_msg = dupz(msg ? msg : "_cz_call raised");
    if (ps) py->DecRef(ps);
    if (pt) py->DecRef(pt);
    if (pv) py->DecRef(pv);
    if (ptb) py->DecRef(ptb);
    goto done;
  }

  {
    char *os = dict_str(py, res, "outcome");
    r->outcome = outcome_of(os);
    free(os);
  }
  r->value = dict_str(py, res, "value");
  r->out = dict_str(py, res, "stdout");
  r->err = dict_str(py, res, "stderr");
  r->sha = dict_str(py, res, "content_sha256");
  PyObject *ed = py->Dict_GetItemString(res, "error");
  if (ed) {
    r->err_type = dict_str(py, ed, "type");
    r->err_msg = dict_str(py, ed, "message");
    r->err_tb = dict_str(py, ed, "traceback");
    r->err_file = dict_str(py, ed, "file");
    r->err_line = dict_long(py, ed, "line");
  }
  py->DecRef(res);
done:
  clock_gettime(CLOCK_MONOTONIC, &t1);
  r->duration_ms = (t1.tv_sec - t0.tv_sec) * 1000 +
                   (t1.tv_nsec - t0.tv_nsec) / 1000000;
  return 0;
}

void cz_interrupt(cz_ctx *c) {
  if (c && c->py.Err_SetInterrupt) c->py.Err_SetInterrupt(SIGINT);
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
