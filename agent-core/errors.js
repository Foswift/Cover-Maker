'use strict';

const CODES = Object.freeze({
  APP_START_FAILED: 'APP_START_FAILED',
  APP_START_TIMEOUT: 'APP_START_TIMEOUT',
  MCP_NOT_READY: 'MCP_NOT_READY',
  AGENT_CONFIG_WRITE_FAILED: 'AGENT_CONFIG_WRITE_FAILED',
  AGENT_RESTART_REQUIRED: 'AGENT_RESTART_REQUIRED',
  TASK_BUSY: 'TASK_BUSY',
  TASK_CANCELLED: 'TASK_CANCELLED',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  LAYOUT_FAILED: 'LAYOUT_FAILED',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT'
});

function errorText(value) {
  if (value instanceof Error) return String(value.message);
  return value == null ? '' : String(value);
}

function makeError(code, error, suggestion, retryable) {
  return {
    ok: false,
    code,
    error: errorText(error),
    suggestion: errorText(suggestion),
    retryable: !!retryable
  };
}

module.exports = { CODES, makeError };
