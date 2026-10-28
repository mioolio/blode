// ESP32-S3 UART still camera. No camera GPIO is driven until INIT is received.
// Pin reference: Espressif Arduino CameraWebServer, CAMERA_MODEL_ESP32S3_EYE.
// Build with PSRAM=opi, FlashSize=16M, USB CDC on boot disabled.
#include <Arduino.h>
#include "esp_camera.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "esp_rom_gpio.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "soc/gpio_sig_map.h"
#include "freertos/timers.h"
#include <errno.h>

struct CameraPins {
  int pwdn, reset, xclk, sda, scl;
  int d0, d1, d2, d3, d4, d5, d6, d7;
  int vsync, href, pclk;
};
const CameraPins eyePins = {-1, -1, 15, 4, 5, 11, 9, 8, 10, 12, 18, 17, 16, 6, 7, 13};
bool cameraReady = false;
bool customWhiteBalance = false;
bool full5MpActive = false;
String pending;
TimerHandle_t nightTimeoutTimer = nullptr;

void forceCameraClockOff() {
  esp_rom_gpio_connect_out_signal(eyePins.xclk, SIG_GPIO_OUT_IDX, false, false);
  gpio_set_direction((gpio_num_t)eyePins.xclk, GPIO_MODE_OUTPUT);
  gpio_set_level((gpio_num_t)eyePins.xclk, 0);
}

void nightCaptureTimedOut(TimerHandle_t timer) {
  // Best-effort timeout fallback, not a temperature measurement or power switch.
  forceCameraClockOff();
  ESP.restart(); // setup() never initializes the camera.
}

bool standbyCamera() {
  bool verified = !cameraReady;
  if (cameraReady) {
    sensor_t *s = esp_camera_sensor_get();
    if (s && s->id.PID == OV5640_PID) {
      verified = s->set_reg(s, 0x3008, 0x40, 0x40) == 0 &&
                 s->get_reg(s, 0x3008, 0x40) == 0x40;
    }
    forceCameraClockOff();
    const esp_err_t result = esp_camera_deinit();
    verified = verified && result == ESP_OK;
  }
  forceCameraClockOff();
  cameraReady = false;
  full5MpActive = false;
  customWhiteBalance = false;
  return verified;
}

uint32_t jpegCrc32(const uint8_t *data, size_t count) {
  // ESP ROM applies the initial/final complements; seed 0 matches zlib.crc32.
  return esp_rom_crc32_le(0, data, count);
}

void printInfo() {
  Serial.printf("INFO chip=%s revision=%u flash=%u psram=%u free_psram=%u camera=%u\n",
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getFlashChipSize(),
                ESP.getPsramSize(), ESP.getFreePsram(), cameraReady ? 1 : 0);
  Serial.println("OK INFO");
}

bool tuningReady(const char *command) {
  if (cameraReady) return true;
  Serial.printf("ERROR %s initialize_with_INIT_EYE\n", command);
  return false;
}

bool parseInteger(const String &text, int &value) {
  if (!text.length()) return false;
  char *end = nullptr;
  errno = 0;
  const long parsed = strtol(text.c_str(), &end, 10);
  if (errno || end == text.c_str() || *end || parsed < -32768 || parsed > 32767) return false;
  value = (int)parsed;
  return true;
}

void printStatus() {
  if (!tuningReady("STATUS")) return;
  sensor_t *s = esp_camera_sensor_get();
  const camera_status_t &st = s->status;
  // Status fields are driver-maintained settings; the register block below is live.
  Serial.printf("STATUS sensor_pid=0x%04x whitebal=%u awb_gain=%u wb_mode=%u wbgain_custom=%u gain_ctrl=%u exposure_ctrl=%u aec2=%u ae_level=%d gainceiling=%u agc_gain=%u aec_value=%u denoise=%u lenc=%u saturation=%d brightness=%d contrast=%d sharpness=%d quality=%u full5mp=%u\n",
                s->id.PID, st.awb, st.awb_gain, st.wb_mode, customWhiteBalance,
                st.agc, st.aec, st.aec2, st.ae_level, st.gainceiling, st.agc_gain,
                st.aec_value, st.denoise, st.lenc, st.saturation, st.brightness, st.contrast,
                st.sharpness, st.quality, full5MpActive);
  if (s->id.PID == OV5640_PID) {
    const int registers[] = {0x3400, 0x3401, 0x3402, 0x3403, 0x3404, 0x3405,
                             0x3406, 0x350a, 0x350b, 0x5000, 0x3a18, 0x3a19};
    int values[12];
    for (int i = 0; i < 12; ++i) {
      values[i] = s->get_reg(s, registers[i], 0xff);
      if (values[i] < 0) {
        Serial.printf("ERROR STATUS register_read_failed reg=0x%04x\n", registers[i]);
        return;
      }
    }
    Serial.print("REGS");
    for (int i = 0; i < 12; ++i) Serial.printf(" 0x%04x=0x%02x", registers[i], values[i]);
    Serial.println();
    Serial.printf("GAINS r=%u g=%u b=%u wb_manual=%u analog_raw=%u gain_ceiling_raw=%u lenc_enabled=%u\n",
                  ((values[0] & 15) << 8) | values[1],
                  ((values[2] & 15) << 8) | values[3],
                  ((values[4] & 15) << 8) | values[5], values[6] & 1,
                  ((values[7] & 3) << 8) | values[8],
                  ((values[10] & 3) << 8) | values[11], (values[9] >> 7) & 1);
  }
  Serial.println("OK STATUS");
}

void setParameter(const String &arguments) {
  if (!tuningReady("SET")) return;
  const int separator = arguments.indexOf(' ');
  int value;
  String name = arguments.substring(0, separator);
  String text = separator >= 0 ? arguments.substring(separator + 1) : "";
  text.trim();
  if (separator < 1 || !parseInteger(text, value)) {
    Serial.println("ERROR SET syntax_SET_parameter_integer"); return;
  }
  sensor_t *s = esp_camera_sensor_get();
  const bool ov5640 = s->id.PID == OV5640_PID;
  struct Parameter { const char *name; int low, high; int (*setter)(sensor_t *, int); };
  const Parameter parameters[] = {
    {"WHITEBAL", 0, 1, s->set_whitebal}, {"AWB_GAIN", 0, 1, s->set_awb_gain},
    {"WB_MODE", 0, 4, s->set_wb_mode}, {"GAIN_CTRL", 0, 1, s->set_gain_ctrl},
    {"EXPOSURE_CTRL", 0, 1, s->set_exposure_ctrl}, {"AEC2", 0, 1, s->set_aec2},
    {"AGC_GAIN", 0, ov5640 ? 64 : 30, s->set_agc_gain},
    {"AEC_VALUE", 0, 1200, s->set_aec_value},
    {"QUALITY", 4, 63, s->set_quality},
    {"AE_LEVEL", ov5640 ? -5 : -2, ov5640 ? 5 : 2, s->set_ae_level},
    {"DENOISE", 0, 8, s->set_denoise}, {"LENC", 0, 1, s->set_lenc},
    {"SATURATION", ov5640 ? -4 : -2, ov5640 ? 4 : 2, s->set_saturation},
    {"BRIGHTNESS", ov5640 ? -3 : -2, ov5640 ? 3 : 2, s->set_brightness},
    {"CONTRAST", ov5640 ? -3 : -2, ov5640 ? 3 : 2, s->set_contrast},
    {"SHARPNESS", ov5640 ? -3 : -2, ov5640 ? 3 : 2, s->set_sharpness}
  };
  int result = -1;
  bool found = false;
  int low = 0, high = 0;
  if (name == "GAINCEILING") {
    found = true;
    // OV5640 driver writes a raw 10-bit gain code; 16 represents approximately 1x.
    // Other drivers use the generic gainceiling_t enum values 0..6.
    low = ov5640 ? 16 : 0; high = ov5640 ? 1023 : 6;
    if (value >= low && value <= high && s->set_gainceiling)
      result = s->set_gainceiling(s, (gainceiling_t)value);
  } else {
    for (const Parameter &p : parameters) {
      if (name != p.name) continue;
      found = true; low = p.low; high = p.high;
      if (value >= low && value <= high && p.setter) result = p.setter(s, value);
      break;
    }
  }
  if (!found) { Serial.println("ERROR SET unknown_parameter"); return; }
  if (value < low || value > high) {
    Serial.printf("ERROR SET out_of_range min=%d max=%d\n", low, high); return;
  }
  if (result != 0) {
    Serial.printf("ERROR SET name=%s rc=%d\n", name.c_str(), result); return;
  }
  if (name == "WB_MODE" || name == "AWB_GAIN") customWhiteBalance = false;
  name.toLowerCase();
  Serial.printf("OK SET %s=%d\n", name.c_str(), value);
}

void setWhiteBalanceGains(const String &arguments) {
  if (!tuningReady("WBGAIN")) return;
  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID != OV5640_PID || !s->get_reg || !s->set_reg || !s->set_whitebal) {
    Serial.println("ERROR WBGAIN requires_OV5640"); return;
  }
  const int first = arguments.indexOf(' '), second = arguments.indexOf(' ', first + 1);
  int gains[3];
  if (first < 1 || second < first + 2 ||
      !parseInteger(arguments.substring(0, first), gains[0]) ||
      !parseInteger(arguments.substring(first + 1, second), gains[1]) ||
      !parseInteger(arguments.substring(second + 1), gains[2])) {
    Serial.println("ERROR WBGAIN syntax_WBGAIN_r_g_b"); return;
  }
  for (int gain : gains) {
    if (gain < 256 || gain > 4095) {
      Serial.println("ERROR WBGAIN out_of_range min=256 max=4095"); return;
    }
  }
  int oldRegisters[7];
  for (int i = 0; i < 7; ++i) {
    oldRegisters[i] = s->get_reg(s, 0x3400 + i, 0xff);
    if (oldRegisters[i] < 0) { Serial.println("ERROR WBGAIN prior_register_read_failed"); return; }
  }
  const int oldWhitebal = s->status.awb;
  // The AWB processing block must stay enabled to apply gains; bit 0 of 0x3406
  // selects manual gains and stops the automatic gain calculation.
  int result = s->set_whitebal(s, 1);
  if (!result) result = s->set_reg(s, 0x3406, 0x01, 1);
  for (int channel = 0; !result && channel < 3; ++channel) {
    const int reg = 0x3400 + channel * 2;
    result = s->set_reg(s, reg, 0x0fff, gains[channel]);
    if (!result && s->get_reg(s, reg, 0x0fff) != gains[channel]) result = -2;
  }
  if (!result && s->get_reg(s, 0x3406, 1) != 1) result = -3;
  if (result) {
    bool restored = true;
    for (int i = 0; i < 7; ++i)
      if (s->set_reg(s, 0x3400 + i, 0xff, oldRegisters[i])) restored = false;
    if (s->set_whitebal(s, oldWhitebal)) restored = false;
    Serial.printf("ERROR WBGAIN rc=%d rollback=%u\n", result, restored); return;
  }
  customWhiteBalance = true;
  Serial.printf("OK WBGAIN r=%d g=%d b=%d manual=1\n", gains[0], gains[1], gains[2]);
}

void initializeCamera(const String &profile, bool singleShot) {
  if (profile != "EYE" && profile != "FREENOVE") {
    Serial.println("ERROR INIT unknown_profile use_EYE_or_FREENOVE");
    return;
  }
  if (cameraReady) {
    Serial.println("OK INIT already_initialized");
    return;
  }
  if (!psramFound()) {
    Serial.println("ERROR INIT PSRAM_not_found_build_with_PSRAM_opi");
    return;
  }
  const CameraPins &p = eyePins;
  camera_config_t c = {};
  c.pin_pwdn = p.pwdn; c.pin_reset = p.reset; c.pin_xclk = p.xclk;
  c.pin_sccb_sda = p.sda; c.pin_sccb_scl = p.scl;
  c.pin_d0 = p.d0; c.pin_d1 = p.d1; c.pin_d2 = p.d2; c.pin_d3 = p.d3;
  c.pin_d4 = p.d4; c.pin_d5 = p.d5; c.pin_d6 = p.d6; c.pin_d7 = p.d7;
  c.pin_vsync = p.vsync; c.pin_href = p.href; c.pin_pclk = p.pclk;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  // The old core's maximum enum is 2560x1920; allocate its JPEG buffers up front.
  // FULL5MP below programs the OV5640's exact 2592x1944 output via set_res_raw.
  c.frame_size = singleShot ? FRAMESIZE_VGA : FRAMESIZE_QSXGA;
  c.jpeg_quality = singleShot ? 16 : 12;
  c.fb_count = singleShot ? 1 : 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = singleShot ? CAMERA_GRAB_WHEN_EMPTY : CAMERA_GRAB_LATEST;
  esp_err_t error = esp_camera_init(&c);
  if (error != ESP_OK) {
    forceCameraClockOff();
    Serial.printf("ERROR INIT code=0x%x name=%s\n", error, esp_err_to_name(error));
    return;
  }
  cameraReady = true;
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, FRAMESIZE_VGA);
  // Same OV3660 correction used by Espressif CameraWebServer example.
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }
  delay(1000);
  Serial.printf("OK INIT profile=%s sensor_pid=0x%04x psram=%u\n",
                profile.c_str(), s->id.PID, ESP.getPsramSize());
}

void initCamera(const String &profile) {
  initializeCamera(profile, false);
}

void snapNight() {
  if (!nightTimeoutTimer)
    nightTimeoutTimer = xTimerCreate("night-limit", pdMS_TO_TICKS(7000), pdFALSE,
                                    nullptr, nightCaptureTimedOut);
  if (!nightTimeoutTimer || xTimerStart(nightTimeoutTimer, 0) != pdPASS) {
    forceCameraClockOff();
    Serial.println("ERROR SNAPNIGHT timeout_guard_unavailable");
    return;
  }
  const uint32_t started = millis();
  standbyCamera();
  initializeCamera("EYE", true);
  camera_fb_t *frame = nullptr;
  uint8_t *copy = nullptr;
  size_t length = 0;
  unsigned width = 0, height = 0;
  bool valid = cameraReady;
  if (valid) {
    sensor_t *s = esp_camera_sensor_get();
    valid = s && s->id.PID == OV5640_PID &&
            s->set_exposure_ctrl(s, 1) == 0 && s->set_gain_ctrl(s, 1) == 0 &&
            s->set_aec2(s, 1) == 0 && s->set_denoise(s, 2) == 0 &&
            s->set_lenc(s, 0) == 0;
  }
  for (int i = 0; valid && i < 2; ++i) {
    frame = esp_camera_fb_get();
    if (!frame) { valid = false; break; }
    esp_camera_fb_return(frame);
    frame = nullptr;
  }
  if (valid) {
    frame = esp_camera_fb_get();
    valid = frame && frame->format == PIXFORMAT_JPEG &&
            jpegDimensions(frame->buf, frame->len, width, height) &&
            width == 640 && height == 480;
    if (valid) {
      length = frame->len;
      copy = (uint8_t *)heap_caps_malloc(length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      valid = copy != nullptr;
      if (valid) memcpy(copy, frame->buf, length);
    }
  }
  if (frame) esp_camera_fb_return(frame);
  const bool standbyVerified = standbyCamera();
  xTimerStop(nightTimeoutTimer, 0);
  Serial.printf("IDLE camera=0 standby_verified=%u clock_gpio=%d clock_low=%u active_ms=%u\n",
                standbyVerified, eyePins.xclk, gpio_get_level((gpio_num_t)eyePins.xclk) == 0,
                millis() - started);
  if (!valid) {
    if (copy) heap_caps_free(copy);
    Serial.println("ERROR SNAPNIGHT capture_failed_camera_stopped");
    return;
  }
  Serial.printf("JPEG %u %u %u %08lx\n", (unsigned)length, width, height,
                (unsigned long)jpegCrc32(copy, length));
  Serial.write(copy, length);
  Serial.flush();
  heap_caps_free(copy);
  Serial.print("\nEND\n");
}

bool jpegDimensions(const uint8_t *data, size_t length, unsigned &width, unsigned &height) {
  if (length < 4 || data[0] != 0xff || data[1] != 0xd8) return false;
  size_t pos = 2;
  while (pos + 3 < length) {
    if (data[pos++] != 0xff) return false;
    while (pos < length && data[pos] == 0xff) ++pos;
    if (pos >= length) return false;
    const uint8_t marker = data[pos++];
    if (marker == 0xd9 || marker == 0xda) return false;
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (pos + 2 > length) return false;
    const size_t segment = ((size_t)data[pos] << 8) | data[pos + 1];
    if (segment < 2 || segment > length - pos) return false;
    const bool sof = marker >= 0xc0 && marker <= 0xcf &&
                     marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
    if (sof) {
      if (segment < 8) return false;
      height = ((unsigned)data[pos + 3] << 8) | data[pos + 4];
      width = ((unsigned)data[pos + 5] << 8) | data[pos + 6];
      return width && height;
    }
    pos += segment;
  }
  return false;
}

void sendJpegFrame(camera_fb_t *frame, const char *command) {
  if (!frame) { Serial.printf("ERROR %s no_frame\n", command); return; }
  if (frame->format != PIXFORMAT_JPEG || frame->len < 4 ||
      frame->buf[0] != 0xff || frame->buf[1] != 0xd8) {
    esp_camera_fb_return(frame);
    Serial.printf("ERROR %s invalid_jpeg\n", command); return;
  }
  unsigned width = 0, height = 0;
  if (!jpegDimensions(frame->buf, frame->len, width, height) ||
      (full5MpActive && (width != 2592 || height != 1944))) {
    esp_camera_fb_return(frame);
    Serial.printf("ERROR %s unexpected_jpeg_dimensions width=%u height=%u\n", command, width, height);
    return;
  }
  const uint32_t crc = jpegCrc32(frame->buf, frame->len);
  Serial.printf("JPEG %u %u %u %08lx\n", (unsigned)frame->len,
                width, height, (unsigned long)crc);
  size_t sent = 0;
  while (sent < frame->len) {
    const size_t written = Serial.write(frame->buf + sent, frame->len - sent);
    sent += written;
    if (!written) yield();
  }
  Serial.flush();
  esp_camera_fb_return(frame);
  Serial.print("\nEND\n");
}

void capture(const String &resolution) {
  if (!cameraReady) { Serial.println("ERROR CAPTURE initialize_with_INIT_EYE"); return; }
  framesize_t size;
  const bool exact5Mp = resolution == "FULL5MP";
  if (resolution == "QVGA") size = FRAMESIZE_QVGA;
  else if (resolution == "VGA") size = FRAMESIZE_VGA;
  else if (resolution == "SVGA") size = FRAMESIZE_SVGA;
  else if (resolution == "XGA") size = FRAMESIZE_XGA;
  else if (resolution == "UXGA") size = FRAMESIZE_UXGA;
  else if (resolution == "QXGA") size = FRAMESIZE_QXGA;
  else if (resolution == "QSXGA" || exact5Mp) size = FRAMESIZE_QSXGA;
  else { Serial.println("ERROR CAPTURE use_QVGA_VGA_SVGA_XGA_UXGA_QXGA_QSXGA_FULL5MP"); return; }
  sensor_t *s = esp_camera_sensor_get();
  if (exact5Mp && (s->id.PID != OV5640_PID || !s->set_res_raw)) {
    Serial.println("ERROR CAPTURE FULL5MP_requires_OV5640"); return;
  }
  if (s->set_framesize(s, size) != 0) {
    Serial.println("ERROR CAPTURE unsupported_resolution"); return;
  }
  full5MpActive = false;
  if (exact5Mp) {
    // Full-array timing from Linux OV5640 and ArduCAM manufacturer register tables.
    const int result = s->set_res_raw(s, 0, 0, 2623, 1951, 16, 4,
                                      2844, 1968, 2592, 1944, false, false);
    if (result) { Serial.printf("ERROR CAPTURE FULL5MP_setup_failed rc=%d\n", result); return; }
    full5MpActive = true;
  }
  delay(700);
  // Let exposure and white balance settle, and discard stale buffer contents.
  for (int i = 0; i < 4; ++i) {
    camera_fb_t *discard = esp_camera_fb_get();
    if (discard) esp_camera_fb_return(discard);
    delay(200);
  }
  sendJpegFrame(esp_camera_fb_get(), "CAPTURE");
}

void preview(const String &resolution) {
  if (!tuningReady("PREVIEW")) return;
  framesize_t size;
  if (resolution == "QVGA") size = FRAMESIZE_QVGA;
  else if (resolution == "VGA") size = FRAMESIZE_VGA;
  else if (resolution == "SVGA") size = FRAMESIZE_SVGA;
  else { Serial.println("ERROR PREVIEW use_QVGA_VGA_SVGA"); return; }
  sensor_t *s = esp_camera_sensor_get();
  const bool changed = full5MpActive || s->status.framesize != size;
  if (changed && s->set_framesize(s, size) != 0) {
    Serial.println("ERROR PREVIEW unsupported_resolution"); return;
  }
  full5MpActive = false;
  // Two buffers with GRAB_LATEST keep preview current; only drain a size change.
  for (int i = 0; i < (changed ? 3 : 0); ++i) {
    camera_fb_t *discard = esp_camera_fb_get();
    if (!discard) { Serial.println("ERROR PREVIEW no_warmup_frame"); return; }
    esp_camera_fb_return(discard);
  }
  sendJpegFrame(esp_camera_fb_get(), "PREVIEW");
}

void setBaud(const String &rateText) {
  if (rateText != "115200" && rateText != "230400" && rateText != "460800" &&
      rateText != "921600" && rateText != "1000000" && rateText != "1500000" && rateText != "2000000") {
    Serial.println("ERROR BAUD use_115200_230400_460800_921600_1000000_1500000_2000000"); return;
  }
  const uint32_t rate = rateText.toInt();
  // The host receives this complete reply at its current rate before switching.
  Serial.printf("OK BAUD %u\n", rate);
  Serial.flush();
  delay(50);
  Serial.updateBaudRate(rate);
}

void execute(String command) {
  command.trim(); command.toUpperCase();
  if (command == "INFO") printInfo();
  else if (command == "SNAPNIGHT") snapNight();
  else if (command == "STANDBY") {
    const bool verified = standbyCamera();
    Serial.printf("OK STANDBY camera=0 standby_verified=%u clock_low=1\n", verified);
  }
  else if (command == "STATUS") printStatus();
  else if (command.startsWith("SET ")) setParameter(command.substring(4));
  else if (command.startsWith("WBGAIN ")) setWhiteBalanceGains(command.substring(7));
  else if (command.startsWith("INIT ")) initCamera(command.substring(5));
  else if (command.startsWith("CAPTURE ")) capture(command.substring(8));
  else if (command.startsWith("PREVIEW ")) preview(command.substring(8));
  else if (command.startsWith("BAUD ")) setBaud(command.substring(5));
  else if (command == "HELP") Serial.println("OK HELP INFO | INIT EYE | STATUS | SET parameter integer | WBGAIN r g b | BAUD 115200|230400|460800|921600|1000000|1500000|2000000 | PREVIEW QVGA|VGA|SVGA | CAPTURE QVGA|VGA|SVGA|XGA|UXGA|QXGA|QSXGA|FULL5MP");
  else if (command.length()) Serial.println("ERROR unknown_command");
}

void setup() {
  forceCameraClockOff();
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  esp_log_level_set("*", ESP_LOG_NONE);
  delay(300);
  Serial.println("READY SERIAL_CAMERA 1");
}

void loop() {
  while (Serial.available()) {
    const char ch = Serial.read();
    if (ch == '\n') { execute(pending); pending = ""; }
    else if (ch != '\r') {
      if (pending.length() < 100) pending += ch;
      else { pending = ""; Serial.println("ERROR command_too_long"); }
    }
  }
  delay(2);
}
