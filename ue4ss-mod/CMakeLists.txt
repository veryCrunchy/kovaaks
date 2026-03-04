cmake_minimum_required(VERSION 3.20)
project(KovaaksBridgeMod LANGUAGES CXX)
include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32)
  message(FATAL_ERROR "KovaaksBridgeMod is Windows-only.")
endif()

option(KOVAAKS_BUILD_STRIPPED_PRODUCTION "Build stripped production bridge source" OFF)

if(NOT DEFINED UE4SS_SDK_DIR)
  message(FATAL_ERROR "Set UE4SS_SDK_DIR to your UE4SS C++ SDK path.")
endif()

set(KOVAAKS_BRIDGE_SOURCE src/KovaaksBridgeMod.cpp)
if(KOVAAKS_BUILD_STRIPPED_PRODUCTION)
  set(KOVAAKS_BRIDGE_SOURCE src/KovaaksBridgeMod.production.cpp)
  message(STATUS "KovaaksBridgeMod: stripped production mode enabled")
else()
  message(STATUS "KovaaksBridgeMod: full bridge mode enabled")
endif()

add_library(main SHARED
  ${KOVAAKS_BRIDGE_SOURCE}
  src/rust_bridge.cpp
)

set(FMT_INCLUDE_DIR "")
if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/fmt/include/fmt/core.h)
  set(FMT_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/fmt/include)
else()
  if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/fmt/patch_fmt.cmake)
    file(TO_CMAKE_PATH "${UE4SS_SDK_DIR}/../deps/third/fmt" UE4SS_FMT_PATCH_DIR)
    file(TO_CMAKE_PATH "${UE4SS_SDK_DIR}/../deps/third/fmt/patch_fmt.cmake" UE4SS_FMT_PATCH_SCRIPT)
    FetchContent_Declare(fmt_headers
      GIT_REPOSITORY https://github.com/fmtlib/fmt.git
      GIT_TAG 11.2.0
      GIT_SHALLOW TRUE
      PATCH_COMMAND ${CMAKE_COMMAND}
        -DPATCH_SCRIPT_DIR=${UE4SS_FMT_PATCH_DIR}
        -P ${UE4SS_FMT_PATCH_SCRIPT}
    )
  else()
    FetchContent_Declare(fmt_headers
      GIT_REPOSITORY https://github.com/fmtlib/fmt.git
      GIT_TAG 11.2.0
      GIT_SHALLOW TRUE
    )
  endif()
  FetchContent_MakeAvailable(fmt_headers)
  set(FMT_INCLUDE_DIR ${fmt_headers_SOURCE_DIR}/include)
endif()

set(IMGUI_INCLUDE_DIR "")
if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/imgui/imgui.h)
  set(IMGUI_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/imgui)
else()
  FetchContent_Declare(imgui_headers
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG v1.92.1
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(imgui_headers)
  set(IMGUI_INCLUDE_DIR ${imgui_headers_SOURCE_DIR})
endif()

set(IMGUI_TEXTEDIT_INCLUDE_DIR "")
if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/ImGuiColorTextEdit/TextEditor.h)
  set(IMGUI_TEXTEDIT_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/ImGuiColorTextEdit)
elseif(EXISTS ${UE4SS_SDK_DIR}/../deps/third/imguitextedit/TextEditor.h)
  set(IMGUI_TEXTEDIT_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/imguitextedit)
else()
  FetchContent_Declare(imgui_textedit_headers
    GIT_REPOSITORY https://github.com/UE4SS-RE/ImGuiColorTextEdit.git
    GIT_TAG v1.2.0
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(imgui_textedit_headers)
  set(IMGUI_TEXTEDIT_INCLUDE_DIR ${imgui_textedit_headers_SOURCE_DIR})
endif()

set(ZYDIS_INCLUDE_DIR "")
set(ZYCORE_INCLUDE_DIR "")
if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/zydis/include/Zydis/Zydis.h)
  set(ZYDIS_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/zydis/include)
  if(EXISTS ${UE4SS_SDK_DIR}/../deps/third/zydis/dependencies/zycore/include/Zycore/Zycore.h)
    set(ZYCORE_INCLUDE_DIR ${UE4SS_SDK_DIR}/../deps/third/zydis/dependencies/zycore/include)
  endif()
else()
  FetchContent_Declare(zydis_headers
    URL https://github.com/zyantific/zydis/archive/refs/tags/v4.1.1.zip
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  )
  FetchContent_GetProperties(zydis_headers)
  if(NOT zydis_headers_POPULATED)
    cmake_policy(PUSH)
    if(POLICY CMP0169)
      cmake_policy(SET CMP0169 OLD)
    endif()
    FetchContent_Populate(zydis_headers)
    cmake_policy(POP)
  endif()
  if(EXISTS ${zydis_headers_SOURCE_DIR}/include/Zydis/Zydis.h)
    set(ZYDIS_INCLUDE_DIR ${zydis_headers_SOURCE_DIR}/include)
  endif()
  if(EXISTS ${zydis_headers_SOURCE_DIR}/dependencies/zycore/include/Zycore/Zycore.h)
    set(ZYCORE_INCLUDE_DIR ${zydis_headers_SOURCE_DIR}/dependencies/zycore/include)
  else()
    FetchContent_Declare(zycore_headers
      URL https://github.com/zyantific/zycore-c/archive/refs/tags/v1.5.2.zip
      DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_GetProperties(zycore_headers)
    if(NOT zycore_headers_POPULATED)
      cmake_policy(PUSH)
      if(POLICY CMP0169)
        cmake_policy(SET CMP0169 OLD)
      endif()
      FetchContent_Populate(zycore_headers)
      cmake_policy(POP)
    endif()
    if(EXISTS ${zycore_headers_SOURCE_DIR}/include/Zycore/Zycore.h)
      set(ZYCORE_INCLUDE_DIR ${zycore_headers_SOURCE_DIR}/include)
    endif()
  endif()
endif()

set(UE4SS_EXTRA_INCLUDE_DIRS "")
set(UE4SS_CANDIDATE_INCLUDE_DIRS
  ${UE4SS_SDK_DIR}/generated_include
  ${UE4SS_SDK_DIR}/../deps/first/Unreal/include
  ${UE4SS_SDK_DIR}/../deps/first/Unreal/include/Unreal
  ${UE4SS_SDK_DIR}/../deps/first/Unreal/include/Unreal/Core
  ${UE4SS_SDK_DIR}/../deps/first/Unreal/generated_include
  ${UE4SS_SDK_DIR}/../deps/first/DynamicOutput/include
  ${UE4SS_SDK_DIR}/../deps/first/Input/include
  ${UE4SS_SDK_DIR}/../deps/first/Constructs/include
  ${UE4SS_SDK_DIR}/../deps/first/Helpers/include
  ${UE4SS_SDK_DIR}/../deps/third/glad/include
  ${UE4SS_SDK_DIR}/../deps/third/imgui
  ${UE4SS_SDK_DIR}/../deps/third/GLFW/include
  ${FMT_INCLUDE_DIR}
  ${IMGUI_INCLUDE_DIR}
  ${IMGUI_TEXTEDIT_INCLUDE_DIR}
  ${ZYDIS_INCLUDE_DIR}
  ${ZYCORE_INCLUDE_DIR}
)

file(GLOB UE4SS_FIRST_DEPS_INCLUDE_DIRS LIST_DIRECTORIES true
  ${UE4SS_SDK_DIR}/../deps/first/*/include
)
foreach(dir ${UE4SS_FIRST_DEPS_INCLUDE_DIRS})
  if(EXISTS ${dir})
    list(APPEND UE4SS_CANDIDATE_INCLUDE_DIRS ${dir})
  endif()
endforeach()

foreach(dir ${UE4SS_CANDIDATE_INCLUDE_DIRS})
  if(EXISTS ${dir})
    list(APPEND UE4SS_EXTRA_INCLUDE_DIRS ${dir})
  endif()
endforeach()

target_include_directories(main PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${UE4SS_SDK_DIR}/include
  ${UE4SS_EXTRA_INCLUDE_DIRS}
)

target_compile_definitions(main PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
  FMT_HEADER_ONLY
  PLATFORM_WINDOWS=1
  PLATFORM_MICROSOFT=1
  UBT_COMPILED_PLATFORM=Windows
  UE_BUILD_DEVELOPMENT=1
  UE_BUILD_DEBUG=0
  UE_BUILD_TEST=0
  UE_BUILD_SHIPPING=0
  UE_GAME=1
  UE_EDITOR=0
)

set_target_properties(main PROPERTIES
  OUTPUT_NAME "main"
  PREFIX ""
)

if(MSVC)
  target_compile_options(main PRIVATE /utf-8 /EHsc)
  # UE4SS runtime in-game is release-built; forcing /MD + non-debug STL ABI
  # avoids Debug STL object layout/allocator mismatch across DLL boundaries.
  set_property(TARGET main PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
  target_compile_definitions(main PRIVATE
    _HAS_ITERATOR_DEBUGGING=0
    $<$<CONFIG:Debug>:_ITERATOR_DEBUG_LEVEL=0>
  )
endif()

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/third_party/UE4SS.lib)
  target_link_libraries(main PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/UE4SS.lib)
endif()
