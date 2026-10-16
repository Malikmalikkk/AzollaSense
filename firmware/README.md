# ESP32 sensor node setup

## Install and upload

1. In Arduino IDE, select an ESP32 Dev Module and install Adafruit TSL2591,
   Adafruit Unified Sensor, OneWire, DallasTemperature, ArduinoJson, and
   ESP32Servo.
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
The camera cover servo uses GPIO 13. The Pi requests the cover open while a live
stream or image capture is active, and closed after camera use ends. The ESP32
reports the commanded position after the configured travel time; this is not
physical position feedback. Set `CAMERA_COVER_CLOSED_ANGLE`,
`CAMERA_COVER_OPEN_ANGLE`, and `CAMERA_COVER_TRAVEL_MS` for the installed
mechanism. Test the servo linkage with the camera disconnected, and verify that
both angles stop before the cover binds against its frame.
Connect the servo signal to GPIO 13, power it from a supply sized for its stall
current, and connect that supply ground to ESP32 GND. Do not power the servo
from an ESP32 GPIO or 3.3 V pin.
The pH voltage fields are the measured stable voltages in pH 7 and pH 4 buffer
solutions. The water-level depth is the empty-tank distance from sensor face to
bottom; correction adds to the calculated level. Upload this firmware version
once so the ESP32 reports raw sensor readings for the Pi to calibrate.

## Rain-triggered canopy protection

The analog water-level sensor can be used as a rain-wetness sensor by mounting
its exposed traces where rain can wet them. Connect its D5 signal to ESP32 GPIO
35 through a divider: sensor D5 to GPIO 35 through a 10 kOhm series resistor,
then a 20 kOhm resistor from GPIO 35 to GND. Connect sensor GND to ESP32 GND.
The module is rated for a signal output up to 4.2 V, so do not connect D5
directly to an ESP32 pin. Power the sensor from 3.3 V or 5 V as supported by the
module; retain the divider either way.

The ESP32 averages 16 ADC samples and sends the raw 12-bit value every two
seconds. In Settings > Sensor Settings, watch the live value while the sensor is
dry and wet, set a threshold between those readings, and choose whether wet
readings are above or below that threshold. The initial setting is 2000 ADC
counts with wet readings above the threshold; calibrate it for the installed
sensor before relying on automatic protection. Two consecutive wet readings
activate rain protection. The Pi starts a five-minute drying grace when the
reading first returns to the dry side; rain during that period resets the grace.
The canopy remains deployed during the grace and retracts afterward if the
reading is still dry. Rain deployment overrides light automation, which resumes
after rain protection releases.

The ESP32 boots with outputs off until it receives the Pi's actuator-state
restore command. If Pi commands stop arriving for 6 seconds, it turns outputs
off. The solenoid always starts OFF for safety.

## Serial protocol

ESP32 telemetry is one JSON object per line, for example:

```json
{"type":"telemetry","water_distance_cm":25.2,"temperature":27.1,"ph_voltage":2.51,"lux":46200,"rain_sensor_raw":1375,"canopy_deployed":true,"motor_running":false,"camera_cover_open":false,"camera_cover_moving":false,"solenoid":false,"pump":false,"pump_manual":false,"pump_auto":true,"pump_auto_running":false,"canopy_auto":true}
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
- Manual pump or harvest drain solenoid input suspends pH automation, so an
  automatic drain or refill cannot restart after a manual choice. Re-enable
  pH automation explicitly to resume it. The pump remains interlocked OFF while
  the harvest drain solenoid is open.
- Manual canopy positioning turns canopy automation off. Rain protection and
  light thresholds only move the canopy while canopy automation is enabled.

All relay outputs and HW-039 enables start OFF. Confirm relay-board active level
and load ratings with low-voltage test loads before connecting the pond hardware.
Use a properly rated 12 V supply and relay for the pump and solenoid; ESP32 GPIO
pins only drive the relay input interface and must never power loads directly.
