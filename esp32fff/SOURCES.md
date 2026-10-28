# ESP32-S3 摄像头开发参考

- Espressif 摄像头驱动及 OV3660 支持：https://github.com/espressif/esp32-camera
- Espressif S3-EYE 摄像头引脚：https://github.com/espressif/arduino-esp32/blob/master/libraries/ESP32/examples/Camera/CameraWebServer/camera_pins.h
- Freenove 厂商示例：https://docs.freenove.com/projects/fnk0083/en/latest/fnk0083/codes/C/32_Camera_Web_Server.html
- Espressif 启动和自动烧录说明：https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html

首先使用的 S3-EYE 引脚配置：D0–D7=11,9,8,10,12,18,17,16；XCLK=15；SDA=4；SCL=5；VSYNC=6；HREF=7；PCLK=13；PWDN/RESET=-1。同名第三方开发板可能使用其他接线，最终以实机检测及有效图像验证为准。

实机已检测到 CH340/COM3、ESP32-S3 v0.2、16MB Flash、8MB Octal PSRAM。串口烧录使用 UART0，USB CDC 关闭。
