import test from 'node:test';
import assert from 'node:assert/strict';
import { arduinoExtraProperties } from '../extensions/boards/Esp32_S3_CAM/compiler/arduino-properties';

test('project flags preserve the compile-only switch and linker map from Arduino ESP32 3.x recipes', () => {
  const properties = arduinoExtraProperties(
    [
      'compiler.cpp.flags="@sdk/flags/cpp_flags" -Os',
      'recipe.cpp.o.pattern="g++" {compiler.cpp.extra_flags} source -o object',
      'compiler.c.extra_flags=-MMD -c -DPLATFORM_C',
      'compiler.cpp.extra_flags=-MMD -c -DPLATFORM_CPP',
      'compiler.c.elf.extra_flags=-Wl,--Map="C:/project dir/firmware.map"',
    ].join('\n'),
    ['-O0', '-g'],
    'c23',
  );
  assert.ok(properties.includes('compiler.c.extra_flags=-MMD -c -DPLATFORM_C -std=gnu2x -O0 -g'));
  assert.ok(properties.includes('compiler.cpp.extra_flags=-MMD -c -DPLATFORM_CPP -O0 -g'));
  assert.ok(
    properties.includes(
      'compiler.c.elf.extra_flags=-Wl,--Map="C:/project dir/firmware.map" -Wl,--gc-sections',
    ),
  );
});

test('empty extra flags stay compatible with cores that declare -c in their main flags', () => {
  const properties = arduinoExtraProperties(
    'compiler.cpp.flags=-c\nrecipe.cpp.o.pattern=compile\ncompiler.cpp.extra_flags=\ncompiler.c.extra_flags=',
    ['-Os'],
  );
  assert.ok(properties.includes('compiler.cpp.extra_flags=-Os'));
  assert.throws(() => arduinoExtraProperties('Error during build', ['-Os']), /arduinoBuildProperties/);
});
