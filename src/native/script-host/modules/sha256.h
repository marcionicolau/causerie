/* compact sha256 — hex digest for script fingerprints (FR-004) */
#ifndef CZ_SHA256_H
#define CZ_SHA256_H
#include <stddef.h>
void cz_sha256_hex(const unsigned char *data, size_t len, char out[65]);
#endif
