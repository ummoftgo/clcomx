export interface E2eStepLogger {
  step: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
}

function emit(prefix: string, message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[${prefix}] ${message}`);
    return;
  }

  console.log(`[${prefix}] ${message}`, details);
}

function emitError(prefix: string, message: string, details?: unknown) {
  if (details === undefined) {
    console.error(`[${prefix}] ${message}`);
    return;
  }

  console.error(`[${prefix}] ${message}`, details);
}

export function createStepLogger(scope: string): E2eStepLogger {
  return {
    step(message, details) {
      emit(scope, message, details);
    },
    error(message, details) {
      emitError(scope, message, details);
    },
  };
}
