#pragma once

#include <cstdint>

enum class base_socket_id : std::uint32_t {
  USER = 0,
  SHIELD = 1,
  FIRST_DYNAMIC = 2,
};
