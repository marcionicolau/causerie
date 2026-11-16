// gpu_probe.c - lls_probe: isolated GPU availability check (feature 029).
//
// Usage: lls_probe <backend-dir>
//   <backend-dir> = the gpu/ subdir holding libggml-vulkan/libggml-metal;
//   missing or empty arg scans ggml's default paths.
//
// Loads backend libraries in THIS process only — the Bun parent spawns
// us with a timeout so a driver crash/hang can never reach the app.
// Prints ONE line of JSON to stdout:
//   {"devices":[{"name":"…","backend":"vulkan","freeBytes":N,"totalBytes":N}]}
// Exit 0 always on success, including when devices is empty.

#include "ggml-backend.h"

#include <stdio.h>
#include <string.h>

int main(int argc, char ** argv) {
    const char * dir = (argc > 1 && argv[1][0] != '\0') ? argv[1] : NULL;
    if (dir != NULL) {
        ggml_backend_load_all_from_path(dir);
    } else {
        ggml_backend_load_all();
    }

    printf("{\"devices\":[");
    int first = 1;
    const size_t n_reg = ggml_backend_reg_count();
    for (size_t i = 0; i < n_reg; i++) {
        ggml_backend_reg_t reg = ggml_backend_reg_get(i);
        const char * backend = ggml_backend_reg_name(reg);
        const size_t n_dev = ggml_backend_reg_dev_count(reg);
        for (size_t j = 0; j < n_dev; j++) {
            ggml_backend_dev_t dev = ggml_backend_reg_dev_get(reg, j);
            const enum ggml_backend_dev_type t = ggml_backend_dev_type(dev);
            if (t != GGML_BACKEND_DEVICE_TYPE_GPU &&
                t != GGML_BACKEND_DEVICE_TYPE_IGPU) {
                continue;
            }
            size_t free_b = 0, total_b = 0;
            ggml_backend_dev_memory(dev, &free_b, &total_b);
            if (!first) {
                putchar(',');
            }
            first = 0;
            // names/descriptions are ASCII-safe in practice; strip the
            // two JSON-hostile characters defensively
            const char * name = ggml_backend_dev_name(dev);
            printf("{\"name\":\"");
            for (const char * p = name; p && *p; p++) {
                if (*p != '"' && *p != '\\' && *p >= 32) putchar(*p);
            }
            printf("\",\"backend\":\"");
            for (const char * p = backend; p && *p; p++) {
                if (*p != '"' && *p != '\\' && *p >= 32) putchar(*p);
            }
            printf("\",\"freeBytes\":%zu,\"totalBytes\":%zu}",
                   free_b, total_b);
        }
    }
    printf("]}\n");
    fflush(stdout);
    return 0;
}
