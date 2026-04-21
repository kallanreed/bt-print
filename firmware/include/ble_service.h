#pragma once

#include "transfer_session.h"

namespace bt_print {

class BleService {
 public:
  void Begin();
  void Poll(TransferSession& session);

 private:
  bool announced_ = false;
};

}  // namespace bt_print
