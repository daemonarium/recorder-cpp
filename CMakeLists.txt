cmake_minimum_required(VERSION 3.17)
project(recorder)

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT TARGET cpp_rpc)
  include(FetchContent)
  FetchContent_Declare(cpp_rpc
    GIT_REPOSITORY https://github.com/daemonarium/rpc-cpp.git
    GIT_TAG v0.2.0
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(cpp_rpc)
endif()
set(RPC_CPP_DIR ${cpp_rpc_SOURCE_DIR})

include_directories(src)

set(WASM_FILES ${RPC_CPP_DIR}/src/utils/socket_handlers.cpp)
aux_source_directory(${RPC_CPP_DIR}/src/io IO_FILES)
aux_source_directory(${RPC_CPP_DIR}/src/socket SOCKET_FILES)

file(GLOB RECORDER_SRC_ALL CONFIGURE_DEPENDS src/*.cpp)
list(FILTER RECORDER_SRC_ALL EXCLUDE REGEX ".*/waosrec(_main|_ut)?\\.cpp$")

set(EXECUTABLE_NAME recorder-wasm)

if(WASM)
  add_executable(${EXECUTABLE_NAME} ${RECORDER_SRC_ALL} ${WASM_FILES} ${IO_FILES} ${SOCKET_FILES})
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
    -Wl,--allow-undefined-file=${RPC_CPP_DIR}/src/examples/modules/allowed-undefined-symbols.syms
  )

  target_include_directories(${EXECUTABLE_NAME} PRIVATE
    src
    ${RPC_CPP_DIR}/src
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

if(NOT WASM)
  include(FetchContent)
  FetchContent_Declare(ut
    GIT_REPOSITORY https://github.com/boost-ext/ut.git
    GIT_TAG v2.0.0
  )
  FetchContent_MakeAvailable(ut)

  add_executable(waosrec
    src/waosrec.cpp
    src/waosrec_main.cpp
  )
  target_include_directories(waosrec PRIVATE
    src
    ${RPC_CPP_DIR}/src
  )
  set_target_properties(waosrec PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
  )

  add_executable(waosrec_ut
    src/waosrec.cpp
    src/waosrec_ut.cpp
  )
  target_include_directories(waosrec_ut PRIVATE
    src
    ${RPC_CPP_DIR}/src
  )
  target_link_libraries(waosrec_ut PRIVATE Boost::ut)
  set_target_properties(waosrec_ut PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/tests
  )
endif()
