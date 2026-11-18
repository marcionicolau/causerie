# feature 028: script host — cz-host process + per-language ABI modules.
# cz-host + libcz_python build unconditionally (Python needs no dev headers —
# the module dlopens libpython); libcz_r only when R headers+lib are found
# (fixes D7: Python is never gated on R availability).

add_executable(cz-host cz-host.c)
target_include_directories(cz-host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
if(UNIX AND NOT APPLE)
    target_link_libraries(cz-host PRIVATE dl)
endif()

add_library(cz_python SHARED modules/python.c modules/sha256.c)
target_include_directories(cz_python PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
set_target_properties(cz_python PROPERTIES PREFIX "lib")
if(UNIX AND NOT APPLE)
    target_link_libraries(cz_python PRIVATE dl)
    set_target_properties(cz_python PROPERTIES
        BUILD_RPATH "$ORIGIN"
        INSTALL_RPATH "$ORIGIN")
    set_target_properties(cz-host PROPERTIES
        BUILD_RPATH "$ORIGIN"
        INSTALL_RPATH "$ORIGIN")
endif()

# R module — only when both the headers and libR are present
find_path(R_INCLUDE_DIR R.h PATHS /usr/lib64/R/include /usr/lib/R/include
        /usr/share/R/include /Library/Frameworks/R.framework/Headers)
find_library(R_LIBRARY R PATHS /usr/lib64/R/lib /usr/lib/R/lib
        /Library/Frameworks/R.framework/Libraries)
if(R_INCLUDE_DIR AND R_LIBRARY)
    add_library(cz_r SHARED modules/r.c modules/sha256.c)
    target_include_directories(cz_r PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}
        ${R_INCLUDE_DIR})
    target_link_libraries(cz_r PRIVATE ${R_LIBRARY})
    set_target_properties(cz_r PROPERTIES PREFIX "lib")
    if(UNIX AND NOT APPLE)
        set_target_properties(cz_r PROPERTIES
            BUILD_RPATH "$ORIGIN;${R_INCLUDE_DIR}/../lib"
            INSTALL_RPATH "$ORIGIN")
    endif()
    message(STATUS "script-host: libcz_r enabled (${R_LIBRARY})")
else()
    message(STATUS "script-host: R headers/lib not found — libcz_r skipped")
endif()
