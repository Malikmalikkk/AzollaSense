/*
 * AzollaSense ESP32 sensor and actuator node.
 *
 * Arduino IDE libraries: Adafruit TSL2591, Adafruit Unified Sensor,
 * OneWire, DallasTemperature, ArduinoJson.
 * Select an ESP32 Dev Module. Serial protocol: one JSON object per line.
 *
 * Sensor thresholds and calibration live on the Raspberry Pi. Verify relay
 * polarity, motor travel time, and GPIOs for the exact modules before loads.
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
constexpr uint32_t TELEMETRY_INTERVAL_MS = 2000;
constexpr uint32_t PI_COMMAND_TIMEOUT_MS = 6000;

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
uint32_t lastPiCommandAt = 0;
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

float readPhVoltage() {
  // The Raspberry Pi applies the saved two-point pH calibration.
  uint32_t sum = 0;
  for (int i = 0; i < 16; ++i) {
    sum += analogRead(PH_PIN);
    delay(2);
  }
  const float adc = sum / 16.0f;
  const float volts = (adc / 4095.0f) * 3.3f;
  return volts;
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

void sendTelemetry(float waterDistance, float temperature, float phVoltage, float lux) {
  StaticJsonDocument<384> doc;
  doc["type"] = "telemetry";
  if (isfinite(waterDistance)) doc["water_distance_cm"] = waterDistance;
  if (isfinite(temperature)) doc["temperature"] = temperature;
  if (isfinite(phVoltage)) doc["ph_voltage"] = phVoltage;
  if (isfinite(lux)) doc["lux"] = lux;
  doc["canopy_deployed"] = canopyDeployed;
  doc["solenoid"] = solenoidOn;
  doc["pump"] = pumpOutput;
  doc["pump_manual"] = pumpManualRequest;
  doc["pump_auto"] = pumpAutoEnabled;
  doc["pump_auto_running"] = pumpAutoRunning;
  doc["canopy_auto"] = canopyAuto;
  doc["motor_running"] = motorOutput;
  serializeJson(doc, Serial);
  Serial.println();
}

void processCommand(const String& line) {
  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, line)) return;
  const bool restoringState = doc["type"] == "restore_state";
  const bool heartbeat = doc["type"] == "heartbeat";
  if (restoringState || heartbeat) controllerReady = true;

  if (!controllerReady && !restoringState) return;
  lastPiCommandAt = millis();

  if (doc.containsKey("canopy_auto")) {
    canopyAuto = doc["canopy_auto"].as<bool>();
  }
  if (doc.containsKey("motor")) {
    if (!restoringState) canopyAuto = false;
    moveCanopy(doc["motor"].as<bool>());
  }
  if (doc.containsKey("auto_motor")) moveCanopy(doc["auto_motor"].as<bool>());
  if (doc.containsKey("solenoid")) solenoidOn = doc["solenoid"].as<bool>();
  if (doc.containsKey("pump")) pumpManualRequest = doc["pump"].as<bool>();
  if (doc.containsKey("pump_auto")) pumpAutoEnabled = doc["pump_auto"].as<bool>();
  if (doc.containsKey("pump_auto_running")) pumpAutoRunning = doc["pump_auto_running"].as<bool>();
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

  if (controllerReady && now - lastPiCommandAt > PI_COMMAND_TIMEOUT_MS) {
    controllerReady = false;
    solenoidOn = false;
    pumpAutoRunning = false;
    motorOutput = false;
  }

  float lux = NAN;
  const uint32_t full = tsl.getFullLuminosity();
  const uint16_t ir = full >> 16;
  const uint16_t visible = full & 0xFFFF;
  const float measuredLux = tsl.calculateLux(visible, ir);
  if (measuredLux >= 0 && isfinite(measuredLux)) lux = measuredLux;

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
  waterTemp.requestTemperatures();
  const float temperature = waterTemp.getTempCByIndex(0);
  const float phVoltage = readPhVoltage();

  pumpOutput = controllerReady && !solenoidOn && (pumpManualRequest || pumpAutoRunning);
  setMotorDriver(motorOutput, motorDirectionDeploy);
  setRelay(SOLENOID_RELAY_PIN, solenoidOn);
  setRelay(PUMP_RELAY_PIN, pumpOutput);

  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    sendTelemetry(distance, temperature, phVoltage, lux);
  }
  delay(20);
}
