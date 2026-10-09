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
constexpr float TANK_DEPTH_CM = 50.0f;       // sensor face to pond bottom
constexpr float TARGET_WATER_LEVEL_CM = 25.0f;
constexpr float PUMP_STOP_HYSTERESIS_CM = 2.0f;
constexpr float CANOPY_DEPLOY_LUX = 45000.0f;
constexpr float CANOPY_RELEASE_LUX = 35000.0f;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 2000;
constexpr uint32_t MOTOR_TRAVEL_MS = 8000;  // tune for full canopy travel; add limit switches

// Calibrate using known pH buffer solutions. Default is only a starting point.
constexpr float PH_NEUTRAL_VOLTAGE = 2.50f;
constexpr float PH_SLOPE_PER_VOLT = -5.70f;

Adafruit_TSL2591 tsl = Adafruit_TSL2591(2591);
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature waterTemp(&oneWire);

bool canopyAuto = true;
bool canopyDeployed = false;
bool solenoidOn = false;
bool pumpManualRequest = false;
bool pumpAutoEnabled = true;
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
  return 7.0f + (volts - PH_NEUTRAL_VOLTAGE) * PH_SLOPE_PER_VOLT;
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
  StaticJsonDocument<192> doc;
  if (deserializeJson(doc, line)) return;

  if (doc.containsKey("canopy_auto")) {
    canopyAuto = doc["canopy_auto"].as<bool>();
  }
  if (doc.containsKey("motor")) {
    canopyAuto = false;
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
    } else if (c != '\r' && inputLine.length() < 256) {
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

  if (canopyAuto && isfinite(lux)) {
    if (lux >= CANOPY_DEPLOY_LUX && !canopyDeployed && !motorOutput) moveCanopy(true);
    if (lux <= CANOPY_RELEASE_LUX && canopyDeployed && !motorOutput) moveCanopy(false);
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
  const float waterLevel = isfinite(distance) ? TANK_DEPTH_CM - distance : NAN;
  waterTemp.requestTemperatures();
  const float temperature = waterTemp.getTempCByIndex(0);
  const float ph = readPh();

  if (pumpAutoEnabled && isfinite(waterLevel) && !solenoidOn) {
    if (!pumpAutoRunning && waterLevel <= TARGET_WATER_LEVEL_CM) pumpAutoRunning = true;
    if (pumpAutoRunning && waterLevel >= TARGET_WATER_LEVEL_CM + PUMP_STOP_HYSTERESIS_CM)
      pumpAutoRunning = false;
  } else {
    pumpAutoRunning = false;
  }

  pumpOutput = !solenoidOn && (pumpManualRequest || pumpAutoRunning);
  setMotorDriver(motorOutput, motorDirectionDeploy);
  setRelay(SOLENOID_RELAY_PIN, solenoidOn);
  setRelay(PUMP_RELAY_PIN, pumpOutput);

  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    sendTelemetry(waterLevel, temperature, ph, lux);
  }
  delay(20);
}
