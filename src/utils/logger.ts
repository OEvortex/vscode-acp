import * as vscode from "vscode";

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

class Logger {
  private outputChannel: vscode.OutputChannel;
  private level: LogLevel = LogLevel.Info;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("VSCode ACP");
  }

  public setLogLevel(level: LogLevel) {
    this.level = level;
  }

  public debug(message: string, ...args: any[]) {
    this.log(LogLevel.Debug, message, ...args);
  }

  public info(message: string, ...args: any[]) {
    this.log(LogLevel.Info, message, ...args);
  }

  public warn(message: string, ...args: any[]) {
    this.log(LogLevel.Warn, message, ...args);
  }

  public error(message: string, error?: any) {
    let fullMessage = message;
    if (error) {
      if (error instanceof Error) {
        fullMessage += `\n${error.stack || error.message}`;
      } else {
        fullMessage += `\n${JSON.stringify(error, null, 2)}`;
      }
    }
    this.log(LogLevel.Error, fullMessage);
  }

  private log(level: LogLevel, message: string, ...args: any[]) {
    if (level < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level].toUpperCase();
    let formattedMessage = `[${timestamp}] [${levelName}] ${message}`;

    if (args.length > 0) {
      formattedMessage +=
        " " +
        args
          .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : a))
          .join(" ");
    }

    this.outputChannel.appendLine(formattedMessage);
  }

  public show() {
    this.outputChannel.show();
  }

  public appendLine(message: string) {
    this.outputChannel.appendLine(message);
  }
}

export const logger = new Logger();
