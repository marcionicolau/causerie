# Contract: shim entry point

```c
// n_ctx == 0 → 4096. Effective n_ctx = min(n_ctx, llama_model_n_ctx_train(model)) (when train > 0).
// Returns NULL and sets *err on failure (including allocation failure).
LLS_API lls_ctx * lls_ctx_create_ex(lls_model * m, uint32_t n_ctx, char ** err);
LLS_API lls_ctx * lls_ctx_create(lls_model * m, char ** err);   // unchanged signature; calls _ex(m, 0, err)
```
`lls_ctx_size(ctx)` continues to return the effective value. `ffi.ts` adds `lls_ctx_create_ex: { args: [ptr, u32, ptr], returns: ptr }`. The TypeScript caller validates the integer range before the call (boundary rule).
