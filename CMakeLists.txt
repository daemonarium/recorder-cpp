cmake_minimum_required(VERSION 3.17)
project(recorder)

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include_directories(src)
aux_source_directory(src SRC_FILES)

set(WASM_FILES ${CMAKE_SOURCE_DIR}/cpp-rpc/src/utils/socket_handlers.cpp)
aux_source_directory(${CMAKE_SOURCE_DIR}/cpp-rpc/src/io IO_FILES)
aux_source_directory(${CMAKE_SOURCE_DIR}/cpp-rpc/src/socket SOCKET_FILES)

set(EXECUTABLE_NAME recorder-wasm)

if(WASM)
  add_executable(${EXECUTABLE_NAME} ${SRC_FILES} ${WASM_FILES} ${IO_FILES} ${SOCKET_FILES})
  target_compile_options(${EXECUTABLE_NAME} PRIVATE
    -fwasm-exceptions
  )
  target_link_options(${EXECUTABLE_NAME} PRIVATE
    -s STANDALONE_WASM=1
    -fwasm-exceptions
    -mbulk-memory
    -Wl,--import-memory
    --no-entry
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=2MB
    -sTOTAL_STACK=64000
    -sEXPORTED_FUNCTIONS=_rpc_description,_start,_malloc,_waos_socket_data,_waos_socket_output_drain
    -sERROR_ON_UNDEFINED_SYMBOLS=0
    -Wl,--allow-undefined-file=${CMAKE_SOURCE_DIR}/cpp-rpc/src/examples/modules/allowed-undefined-symbols.syms
  )

  target_include_directories(${EXECUTABLE_NAME} PRIVATE
    src
    ${CMAKE_SOURCE_DIR}/cpp-rpc/src
  )
  target_compile_definitions(${EXECUTABLE_NAME}
    PRIVATE
      RPC_SERVER
      RPC_TYPE_DESCRIPTION
  )
  set_target_properties(${EXECUTABLE_NAME} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
    OUTPUT_NAME recorder
    SUFFIX ".wasm"
  )
endif()
