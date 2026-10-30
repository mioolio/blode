import { stlinkDriver } from '../boards/STM32F103C8T6/tools/driver.js';
import type { DriverDefinition } from './types.js';

// Explicit registration mirrors the board registry: a workspace cannot inject a driver.
const definitions = [stlinkDriver] as const;

export function listDriverDefinitions(): readonly DriverDefinition[] {
  return definitions;
}

export function getDriverDefinition(id: string): DriverDefinition {
  const definition = definitions.find((item) => item.id === id);
  if (!definition) throw new Error('error.driverUnknown');
  return definition;
}
