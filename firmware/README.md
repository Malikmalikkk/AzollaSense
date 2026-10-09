# ESP32 sensor node setup

## Install and upload

1. In Arduino IDE, select an ESP32 Dev Module and install Adafruit TSL2591,
   Adafruit Unified Sensor, OneWire, DallasTemperature, and ArduinoJson.
2. Open `azollasense_esp32.ino`, set the tank depth, motor travel time, relay
   polarity, and thresholds for your actual installation, then upload it.
3. Install the Python requirements for the web backend, including `pyserial`.
   Close Arduino Serial Monitor before starting the backend; only one program can
   own the ESP32 serial port at a time.
4. The backend auto-detects common USB serial devices. If needed, set
   `AZOLLASENSE_SERIAL_PORT` (`/dev/ttyACM0` on many Raspberry Pi setups or
   `COM5` on Windows) and optionally `AZOLLASENSE_SERIAL_BAUD=115200`.
5. Run `python app-server.py`. Open Settings → Machine Settings for the controls.

The Raspberry Pi saves pump/canopy switch preferences in Flask's `instance`
directory (`instance/actuator_preferences.json`). On an ESP32 reconnect, the Pi
sends those saved settings before the ESP32 enables automatic or manual outputs.
The ESP32 boots with pump and canopy automation disabled and outputs off until
it receives this restore command. The solenoid always starts OFF for safety.

## Serial protocol

ESP32 telemetry is one JSON object per line, for example:

```json
{"type":"telemetry","water_level":24.8,"temperature":27.1,"ph":7.0,"lux":46200,"motor":true,"solenoid":false,"pump":true,"pump_manual":false,"pump_auto":true,"canopy_auto":true}
```

The backend parses that line, updates its shared telemetry state, and its
existing Socket.IO event updates the webapp. Dashboard switch events become
JSON command lines sent back to the ESP32 over the same USB serial connection.

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
drives the reverse/retract direction. The light automation deploys above the
high lux threshold and retracts below the lower threshold. Travel runs for
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

## Defaults that need calibration

- `TANK_DEPTH_CM` is the distance from the ultrasonic sensor face to the pond
  bottom. The sketch reports water level as tank depth minus measured air gap.
- Pump auto-fill starts at or below `TARGET_WATER_LEVEL_CM` and stops at the
  target plus `PUMP_STOP_HYSTERESIS_CM`. Adjust these to your required level.
- The pH voltage equation is only a placeholder. Calibrate the PH-4502C using
  pH buffer solutions and verify the interface output never exceeds the ESP32
  ADC input range. Do not connect a bare pH probe to the ESP32.
- JSN-SR04T Echo may be 5 V; level shift it before the ESP32 input. The sketch
  assumes a 4.7 kΩ DS18B20 data pull-up to 3.3 V.
- Canopy limit switches stop normal travel at each endpoint; `MOTOR_TRAVEL_MS`
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
