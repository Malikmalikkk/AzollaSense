# ESP32 sensor node setup

## Install and upload

1. In Arduino IDE, select an ESP32 Dev Module and install Adafruit TSL2591,
   Adafruit Unified Sensor, OneWire, DallasTemperature, and ArduinoJson.
2. Open `azollasense_esp32.ino`, check GPIOs, motor travel time, and relay
   polarity for your hardware, then upload it. Sensor thresholds and calibration
   are configured in the webapp and stored on the Raspberry Pi.
3. Install the Python requirements for the web backend, including `pyserial`.
   Close Arduino Serial Monitor before starting the backend; only one program can
   own the ESP32 serial port at a time.
4. The backend auto-detects common USB serial devices. If needed, set
   `AZOLLASENSE_SERIAL_PORT` (`/dev/ttyACM0` on many Raspberry Pi setups or
   `COM5` on Windows) and optionally `AZOLLASENSE_SERIAL_BAUD=115200`.
5. Run `python app-server.py`. Open Settings → Machine Settings for the controls.

The Raspberry Pi saves pump/canopy switch preferences in Flask's `instance`
directory (`instance/actuator_preferences.json`) and sensor thresholds and
calibration in `instance/sensor_settings.json`. Settings → Sensor Settings can
change temperature, pH, water-level, canopy-light, browning, pump, pH calibration,
and ultrasonic depth values. The Pi applies those settings locally; it does not
send calibration or threshold configuration to the ESP32 on boot. The Update
Interval controls how often the Pi publishes readings to the app, from 2 seconds
up to 1 hour. The ESP32 sends raw pH voltage and ultrasonic distance every 2 seconds.
The pH voltage fields are the measured stable voltages in pH 7 and pH 4 buffer
solutions. The water-level depth is the empty-tank distance from sensor face to
bottom; correction adds to the calculated level. Upload this firmware version
once so the ESP32 reports raw sensor readings for the Pi to calibrate.
The ESP32 boots with outputs off until it receives the Pi's actuator-state
restore command. If Pi commands stop arriving for 6 seconds, it turns outputs
off. The solenoid always starts OFF for safety.

## Serial protocol

ESP32 telemetry is one JSON object per line, for example:

```json
{"type":"telemetry","water_distance_cm":25.2,"temperature":27.1,"ph_voltage":2.51,"lux":46200,"canopy_deployed":true,"motor_running":false,"solenoid":false,"pump":false,"pump_manual":false,"pump_auto":true,"pump_auto_running":false,"canopy_auto":true}
```

The backend converts pH voltage and ultrasonic distance using its saved Pi
settings, runs pump and canopy threshold logic, then sends actuator commands to
the ESP32. Dashboard switch events use the same serial command link.

## HW-039 / IBT-2 motor driver

The sketch uses the HW-039 as an H-bridge for the canopy's brushed DC motor.
Connect motor power to the board's B+ / B- terminals, the motor to M+ / M-,
and the logic header to the ESP32 as follows:

| HW-039 pin | ESP32 connection |
| --- | --- |
| RPWM | GPIO 25 |
| LPWM | GPIO 26 |
| R_EN | GPIO 32 |
| L_EN | GPIO 33 |
| GND | ESP32 GND |
| VCC | Regulated 5 V logic supply |

The two canopy end-stop switches are active-high in this sketch:

| Switch | ESP32 pin | Wiring for a bare normally-open microswitch |
| --- | --- | --- |
| Fully closed | GPIO 19 | One terminal to GPIO 19, the other to ESP32 3V3 |
| Fully open | GPIO 23 | One terminal to GPIO 23, the other to ESP32 3V3 |

The firmware enables each pin's internal pull-down, so an open switch reads 0
and a pressed/closed contact reads 1. These GPIOs must see no more than 3.3 V;
if the switch assembly outputs 5 V or 12 V instead of being a dry contact,
use an appropriate divider or level shifter. The closed limit stops retracting;
the open limit stops deploying. If both inputs read active together, motor
movement is inhibited. The 8 second `MOTOR_TRAVEL_MS` timeout remains as a
backup if a limit switch or its wiring fails.

The HW-039 is commonly sold as an IBT-2 board built from two BTS7960 half
bridges; check the markings on your exact board. The BTS7960 is an integrated
protected half-bridge intended for PWM motor-drive use ([Infineon datasheet](https://www.infineon.com/dgdl/BTS7960_Datasheet.pdf?folderId=db3a304412b407950112b408e8c900)).

Direction is selected by RPWM vs LPWM, with both enable pins asserted while
driving. The web switch means deployed: ON drives the deploy direction; OFF
drives the reverse/retract direction. The Raspberry Pi sends deploy and retract
commands when the configured lux thresholds are crossed. Travel runs for
`MOTOR_TRAVEL_MS`, which must be tuned to the mechanism. Add end-stop switches
or use a limit-aware actuator/controller where possible; timed travel alone
cannot confirm the canopy reached its end position. Start with the motor
disconnected and verify each direction on the driver outputs first.
At startup, the firmware reads the limit switches to determine whether the
canopy is fully open or fully closed. If neither is active, it assumes the
canopy is not fully open until an end stop is reached.

Board revisions and input-buffer chips vary. The ESP32 outputs 3.3 V logic;
confirm the exact board accepts it at its VCC setting, or add a suitable
3.3-to-5 V logic buffer. Join logic grounds. Do not power the motor from the
ESP32 or its 5 V logic header. Size the supply, wiring, fuse, and driver for
the motor's stall current; the board's advertised peak-current figure is not a
continuous-current rating.

## Sensor calibration and thresholds

- Sensor Settings on the Raspberry Pi stores the empty-tank sensor-to-bottom
  distance and an installation correction. The Pi calculates water level as
  depth minus measured air gap plus the correction.
- The Pi runs pump auto-fill at or below its configured target and stops at the
  target plus the configured margin.
- Calibrate pH using stable PH-4502C output voltages measured in pH 7 and pH 4
  buffer solutions. Verify the interface output never exceeds the ESP32 ADC
  input range. Do not connect a bare pH probe to the ESP32.
- JSN-SR04T Echo may be 5 V; level shift it before the ESP32 input. The sketch
  assumes a 4.7 kΩ DS18B20 data pull-up to 3.3 V.
- Canopy thresholds are evaluated on the Pi. Limit switches stop normal travel
  at each endpoint; `MOTOR_TRAVEL_MS`
  is still a backup timeout and should be set slightly longer than measured
  full travel time.
- The pump manual switch requests pump ON; switching it off removes that request
  while automatic low-water filling remains enabled. The pump is forced off
  while the harvest drain solenoid is open.
- The Machine Settings screen has a separate automatic pump switch. Turning it
  off disables water-level-triggered pumping; the manual pump request remains
  available. Turning it back on resumes the configured water-level logic.

All relay outputs and HW-039 enables start OFF. Confirm relay-board active level
and load ratings with low-voltage test loads before connecting the pond hardware.
Use a properly rated 12 V supply and relay for the pump and solenoid; ESP32 GPIO
pins only drive the relay input interface and must never power loads directly.
