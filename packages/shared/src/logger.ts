export type LogFields = Record<string, unknown>;

function write(level: "info" | "error", message: string, fields?: LogFields): void {
  const record = {
    level,
    msg: message,
    ts: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export function logInfo(message: string, fields?: LogFields): void {
  write("info", message, fields);
}

export function logError(message: string, fields?: LogFields): void {
  write("error", message, fields);
}
