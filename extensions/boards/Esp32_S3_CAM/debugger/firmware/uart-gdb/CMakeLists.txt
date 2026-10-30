cmake_minimum_required(VERSION 3.16)

# Keep the reference image independent of camera, Wi-Fi and Arduino components.
set(COMPONENTS main)
set(PROJECT_VER "uart-gdb-idf5.1.4-context")
include("${CMAKE_CURRENT_LIST_DIR}/cmake/runtime-stub.cmake")
set(BLODE_RUNTIME_STUB "${CMAKE_BINARY_DIR}/blode-components/esp_gdbstub")
blode_prepare_uart_gdbstub("$ENV{IDF_PATH}" "${BLODE_RUNTIME_STUB}")
list(APPEND EXTRA_COMPONENT_DIRS "${BLODE_RUNTIME_STUB}")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(blode_uart_gdb)

if(NOT IDF_VERSION_MAJOR EQUAL 5 OR NOT IDF_VERSION_MINOR EQUAL 1 OR NOT IDF_VERSION_PATCH EQUAL 4)
    message(FATAL_ERROR "This reference firmware requires ESP-IDF v5.1.4")
endif()
