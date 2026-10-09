// Preloaded with --import ahead of the OpenTelemetry register (see the Dockerfile and the start
// scripts), so the stop hook is in place before the slow part of startup begins.
import { processStopSignal } from './platform/lifecycle.js';

processStopSignal();
