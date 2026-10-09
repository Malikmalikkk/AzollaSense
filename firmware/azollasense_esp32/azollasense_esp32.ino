/*
 * AzollaSense ESP32 sensor and actuator node.
 *
 * Arduino IDE libraries: Adafruit TSL2591, Adafruit Unified Sensor,
 * OneWire, DallasTemperature, ArduinoJson.
 * Select an ESP32 Dev Module. Serial protocol: one JSON object per line.
 *
 * Set tank geometry, calibrated pH conversion, relay polarity, thresholds,
 * motor travel time, and GPIOs for the exact modules before connecting loads.
 */
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_TSL2591.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ArduinoJson.h>

// ESP32-WROOM example wiring. GPIO numbers may differ on other boards.
constexpr int PH_PIN = 34;       // PH-4502C conditioned analog output
constexpr int ONE_WIRE_PIN = 4;  // DS18B20 data; add 4.7k pull-up to 3V3
constexpr int SONAR_TRIG_PIN = 5;
constexpr int SONAR_ECHO_PIN = 18; // JSN-SR04T echo must be level-shifted to 3V3
constexpr int CANOPY_CLOSED_LIMIT_PIN = 19;
constexpr int CANOPY_OPEN_LIMIT_PIN = 23;
// HW-039 / IBT-2 / BTS7960 H-bridge control pins.
constexpr int MOTOR_RPWM_PIN = 25;
constexpr int MOTOR_LPWM_PIN = 26;
constexpr int MOTOR_R_EN_PIN = 32;
constexpr int MOTOR_L_EN_PIN = 33;
constexpr int SOLENOID_RELAY_PIN = 27;
constexpr int PUMP_RELAY_PIN = 14;

// Many optocoupler relay boards are active-low. Verify your board before use.
constexpr bool RELAY_ACTIVE_LOW = true;
constexpr uint32_t MOTOR_TRAVEL_MS = 8000;  // tune for full canopy travel; add limit switches

// Calibrate using known pH buffer solutions. Default is only a starting point.
float tankDepthCm = 50.0f;
float waterLevelOffsetCm = 0.0f;
float targetWaterLevelCm = 25.0f;
float pumpStopHysteresisCm = 2.0f;
float canopyDeployLux = 45000.0f;
float canopyReleaseLux = 35000.0f;
float ph7Voltage = 2.50f;
float ph4Voltage = 3.026f;
uint32_t telemetryIntervalMs = 2000;

Adafruit_TSL2591 tsl = Adafruit_TSL2591(2591);
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature waterTemp(&oneWire);

bool controllerReady = false;
bool canopyAuto = false;
bool canopyDeployed = false;
bool solenoidOn = false;
bool pumpManualRequest = false;
bool pumpAutoEnabled = false;
bool pumpAutoRunning = false;
bool motorOutput = false;
bool motorDirectionDeploy = true;
bool pumpOutput = false;
uint32_t motorStartedAt = 0;
uint32_t lastTelemetryAt = 0;
String inputLine;

void setRelay(int pin, bool on) {
  digitalWrite(pin, (on == RELAY_ACTIVE_LOW) ? LOW : HIGH);
}

void setMotorDriver(bool run, bool deploy) {
  // Disable first, set bridge direction, then enable both BTS7960 half bridges.
  digitalWrite(MOTOR_R_EN_PIN, LOW);
  digitalWrite(MOTOR_L_EN_PIN, LOW);
  digitalWrite(MOTOR_RPWM_PIN, deploy && run ? HIGH : LOW);
  digitalWrite(MOTOR_LPWM_PIN, !deploy && run ? HIGH : LOW);
  if (run) {
    digitalWrite(MOTOR_R_EN_PIN, HIGH);
    digitalWrite(MOTOR_L_EN_PIN, HIGH);
  }
}

void moveCanopy(bool deployed) {
  const bool closedLimit = digitalRead(CANOPY_CLOSED_LIMIT_PIN) == HIGH;
  const bool openLimit = digitalRead(CANOPY_OPEN_LIMIT_PIN) == HIGH;
  if (closedLimit && openLimit) {
    motorOutput = false; // contradictory limit inputs: fail safe
    return;
  }
  if (deployed && openLimit) {
    canopyDeployed = true;
    motorOutput = false;
    return;
  }
  if (!deployed && closedLimit) {
    canopyDeployed = false;
    motorOutput = false;
    return;
  }
  if (deployed == canopyDeployed && !motorOutput) return;
  canopyDeployed = deployed;
  motorDirectionDeploy = deployed;
  motorOutput = true;
  motorStartedAt = millis();
}

float readPh() {
  // Average analog samples; calibrate this conversion for your own interface.
  uint32_t sum = 0;
  for (int i = 0; i < 16; ++i) {
    sum += analogRead(PH_PIN);
    delay(2);
  }
  const float adc = sum / 16.0f;
  const float volts = (adc / 4095.0f) * 3.3f;
  return 7.0f + (volts - ph7Voltage) * (4.0f - 7.0f) / (ph4Voltage - ph7Voltage);
}

float readWaterDistanceCm() {
  digitalWrite(SONAR_TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(SONAR_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(SONAR_TRIG_PIN, LOW);
  const uint32_t duration = pulseIn(SONAR_ECHO_PIN, HIGH, 30000UL);
  if (duration == 0) return NAN;
  return duration * 0.0343f / 2.0f;
}

void sendTelemetry(float waterLevel, float temperature, float ph, float lux) {
  StaticJsonDocument<384> doc;
  doc["type"] = "telemetry";
  if (isfinite(waterLevel)) doc["water_level"] = waterLevel;
  if (isfinite(temperature)) doc["temperature"] = temperature;
  if (isfinite(ph)) doc["ph"] = ph;
  if (isfinite(lux)) doc["lux"] = lux;
  doc["motor"] = motorOutput;
  doc["canopy_deployed"] = canopyDeployed;
  doc["solenoid"] = solenoidOn;
  doc["pump"] = pumpOutput;
  doc["pump_manual"] = pumpManualRequest;
  doc["pump_auto"] = pumpAutoEnabled;
  doc["canopy_auto"] = canopyAuto;
  serializeJson(doc, Serial);
  Serial.println();
}

void processCommand(const String& line) {
  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, line)) return;
  const bool restoringState = doc["type"] == "restore_state";
  if (restoringState) controllerReady = true;

  if (doc.containsKey("tank_depth_cm")) tankDepthCm = constrain(doc["tank_depth_cm"].as<float>(), 1.0f, 500.0f);
  if (doc.containsKey("water_level_offset_cm")) waterLevelOffsetCm = constrain(doc["water_level_offset_cm"].as<float>(), -100.0f, 100.0f);
  if (doc.containsKey("pump_target_cm")) targetWaterLevelCm = constrain(doc["pump_target_cm"].as<float>(), 0.0f, 500.0f);
  if (doc.containsKey("pump_hysteresis_cm")) pumpStopHysteresisCm = constrain(doc["pump_hysteresis_cm"].as<float>(), 0.1f, 100.0f);
  if (doc.containsKey("canopy_deploy_lux")) canopyDeployLux = constrain(doc["canopy_deploy_lux"].as<float>(), 0.0f, 200000.0f);
  if (doc.containsKey("canopy_release_lux")) canopyReleaseLux = constrain(doc["canopy_release_lux"].as<float>(), 0.0f, 200000.0f);
  if (doc.containsKey("ph7_voltage")) ph7Voltage = constrain(doc["ph7_voltage"].as<float>(), 0.0f, 3.3f);
  if (doc.containsKey("ph4_voltage")) ph4Voltage = constrain(doc["ph4_voltage"].as<float>(), 0.0f, 3.3f);
  if (doc.containsKey("update_interval_seconds")) telemetryIntervalMs = constrain(doc["update_interval_seconds"].as<uint32_t>(), 2U, 3600U) * 1000UL;
  if (fabsf(ph4Voltage - ph7Voltage) < 0.05f) ph4Voltage = ph7Voltage + (ph7Voltage <= 3.25f ? 0.05f : -0.05f);

  if (!controllerReady && !restoringState) return;

  if (doc.containsKey("canopy_auto")) {
    canopyAuto = doc["canopy_auto"].as<bool>();
  }
  if (doc.containsKey("motor")) {
    if (!restoringState) canopyAuto = false;
    moveCanopy(doc["motor"].as<bool>());
  }
  if (doc.containsKey("solenoid")) solenoidOn = doc["solenoid"].as<bool>();
  if (doc.containsKey("pump")) pumpManualRequest = doc["pump"].as<bool>();
  if (doc.containsKey("pump_auto")) pumpAutoEnabled = doc["pump_auto"].as<bool>();
}

void readSerialCommands() {
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      processCommand(inputLine);
      inputLine = "";
    } else if (c != '\r' && inputLine.length() < 768) {
      inputLine += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(MOTOR_RPWM_PIN, OUTPUT);
  pinMode(MOTOR_LPWM_PIN, OUTPUT);
  pinMode(MOTOR_R_EN_PIN, OUTPUT);
  pinMode(MOTOR_L_EN_PIN, OUTPUT);
  pinMode(SOLENOID_RELAY_PIN, OUTPUT);
  pinMode(PUMP_RELAY_PIN, OUTPUT);
  setMotorDriver(false, true);
  setRelay(SOLENOID_RELAY_PIN, false);
  setRelay(PUMP_RELAY_PIN, false);
  pinMode(SONAR_TRIG_PIN, OUTPUT);
  pinMode(SONAR_ECHO_PIN, INPUT);
  pinMode(CANOPY_CLOSED_LIMIT_PIN, INPUT_PULLDOWN);
  pinMode(CANOPY_OPEN_LIMIT_PIN, INPUT_PULLDOWN);
  const bool closedAtStartup = digitalRead(CANOPY_CLOSED_LIMIT_PIN) == HIGH;
  const bool openAtStartup = digitalRead(CANOPY_OPEN_LIMIT_PIN) == HIGH;
  if (!(closedAtStartup && openAtStartup)) canopyDeployed = openAtStartup;
  analogReadResolution(12);
  Wire.begin();
  waterTemp.begin();
  if (!tsl.begin()) Serial.println("{\"type\":\"warning\",\"sensor\":\"tsl2591\"}");
  tsl.setGain(TSL2591_GAIN_MED);
  tsl.setTiming(TSL2591_INTEGRATIONTIME_200MS);
}

void loop() {
  readSerialCommands();
  const uint32_t now = millis();

  float lux = NAN;
  const uint32_t full = tsl.getFullLuminosity();
  const uint16_t ir = full >> 16;
  const uint16_t visible = full & 0xFFFF;
  const float measuredLux = tsl.calculateLux(visible, ir);
  if (measuredLux >= 0 && isfinite(measuredLux)) lux = measuredLux;

  if (controllerReady && canopyAuto && isfinite(lux)) {
    if (lux >= canopyDeployLux && !canopyDeployed && !motorOutput) moveCanopy(true);
    if (lux <= canopyReleaseLux && canopyDeployed && !motorOutput) moveCanopy(false);
  }
  const bool closedLimit = digitalRead(CANOPY_CLOSED_LIMIT_PIN) == HIGH;
  const bool openLimit = digitalRead(CANOPY_OPEN_LIMIT_PIN) == HIGH;
  if ((closedLimit && openLimit) ||
      (motorOutput && motorDirectionDeploy && openLimit) ||
      (motorOutput && !motorDirectionDeploy && closedLimit)) {
    motorOutput = false;
    motorStartedAt = 0;
    if (openLimit && !closedLimit) canopyDeployed = true;
    if (closedLimit && !openLimit) canopyDeployed = false;
  }
  if (motorOutput && now - motorStartedAt >= MOTOR_TRAVEL_MS) {
    motorOutput = false; // timed travel; limit switches are more reliable
    motorStartedAt = 0;
  }

  const float distance = readWaterDistanceCm();
  const float waterLevel = isfinite(distance) ? tankDepthCm - distance + waterLevelOffsetCm : NAN;
  waterTemp.requestTemperatures();
  const float temperature = waterTemp.getTempCByIndex(0);
  const float ph = readPh();

  if (controllerReady && pumpAutoEnabled && isfinite(waterLevel) && !solenoidOn) {
    if (!pumpAutoRunning && waterLevel <= targetWaterLevelCm) pumpAutoRunning = true;
    if (pumpAutoRunning && waterLevel >= targetWaterLevelCm + pumpStopHysteresisCm)
      pumpAutoRunning = false;
  } else {
    pumpAutoRunning = false;
  }

  pumpOutput = controllerReady && !solenoidOn && (pumpManualRequest || pumpAutoRunning);
  setMotorDriver(motorOutput, motorDirectionDeploy);
  setRelay(SOLENOID_RELAY_PIN, solenoidOn);
  setRelay(PUMP_RELAY_PIN, pumpOutput);

  if (now - lastTelemetryAt >= telemetryIntervalMs) {
    lastTelemetryAt = now;
    sendTelemetry(waterLevel, temperature, ph, lux);
  }
  delay(20);
}
