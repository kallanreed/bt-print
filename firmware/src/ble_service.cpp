#include "ble_service.h"

#include <Arduino.h>

#include "app_config.h"

namespace bt_print {

void BleService::Begin() {
  announced_ = false;
}

void BleService::Poll(TransferSession& session) {
  if (announced_) {
    return;
  }

  announced_ = true;
  Serial.printf(
      "ble-service uuid=%s write=%s notify=%s state=%u\n",
      config::kBleServiceUuid,
      config::kBleWriteCharacteristicUuid,
      config::kBleNotifyCharacteristicUuid,
      static_cast<unsigned>(session.state()));
}

}  // namespace bt_print
