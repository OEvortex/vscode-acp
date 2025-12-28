import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from "child_process";
import { Readable, Writable } from "stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionModeState,
  type SessionModelState,
  type AvailableCommand,
} from "@agentclientprotocol/sdk";
import { type AgentConfig, getDefaultAgent, isAgentAvailable } from "./agents";
import { logger } from "../utils/logger";

export interface SessionMetadata {
  modes: SessionModeState | null;
  models: SessionModelState | null;
  commands: AvailableCommand[] | null;
}

export type ACPConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

type StateChangeCallback = (state: ACPConnectionState) => void;
type SessionUpdateCallback = (update: SessionNotification) => void;
type StderrCallback = (data: string) => void;

export type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface ACPClientOptions {
  agentConfig?: AgentConfig;
  spawn?: SpawnFunction;
  skipAvailabilityCheck?: boolean;
}

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private state: ACPConnectionState = "disconnected";
  private currentSessionId: string | null = null;
  private sessionMetadata: SessionMetadata | null = null;
  private pendingCommands: AvailableCommand[] | null = null;
  private stateChangeListeners: Set<StateChangeCallback> = new Set();
  private sessionUpdateListeners: Set<SessionUpdateCallback> = new Set();
  private stderrListeners: Set<StderrCallback> = new Set();
  private agentConfig: AgentConfig;
  private spawnFn: SpawnFunction;
  private skipAvailabilityCheck: boolean;

  constructor(options?: ACPClientOptions | AgentConfig) {
    if (options && "id" in options) {
      this.agentConfig = options;
      this.spawnFn = nodeSpawn as SpawnFunction;
      this.skipAvailabilityCheck = false;
    } else {
      this.agentConfig = options?.agentConfig ?? getDefaultAgent();
      this.spawnFn = options?.spawn ?? (nodeSpawn as SpawnFunction);
      this.skipAvailabilityCheck = options?.skipAvailabilityCheck ?? false;
    }
  }

  setAgent(config: AgentConfig): void {
    if (this.state !== "disconnected") {
      this.dispose();
    }
    this.agentConfig = config;
  }

  getAgentId(): string {
    return this.agentConfig.id;
  }

  setOnStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);
    return () => this.stateChangeListeners.delete(callback);
  }

  setOnSessionUpdate(callback: SessionUpdateCallback): () => void {
    this.sessionUpdateListeners.add(callback);
    return () => this.sessionUpdateListeners.delete(callback);
  }

  setOnStderr(callback: StderrCallback): () => void {
    this.stderrListeners.add(callback);
    return () => this.stderrListeners.delete(callback);
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): ACPConnectionState {
    return this.state;
  }

  async connect(): Promise<InitializeResponse> {
    if (this.state === "connected" || this.state === "connecting") {
      throw new Error("Already connected or connecting");
    }

    if (!this.skipAvailabilityCheck && !isAgentAvailable(this.agentConfig.id)) {
      throw new Error(
        `Agent "${this.agentConfig.name}" is not installed. ` +
          `Please install "${this.agentConfig.command}" and try again.`
      );
    }

    this.setState("connecting");

    try {
      const spawnOptions: SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      };

      if (process.platform === "win32") {
        spawnOptions.shell = true;
      }

      this.process = this.spawnFn(
        this.agentConfig.command,
        this.agentConfig.args,
        spawnOptions
      );

      this.process.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        logger.error(`[Agent stderr] ${text}`);
        this.stderrListeners.forEach((cb) => cb(text));
      });

      this.process.on("error", (error) => {
        logger.error("Process error", error);
        this.setState("error");
      });

      this.process.on("exit", (code) => {
        logger.info(`Process exited with code: ${code}`);
        this.setState("disconnected");
        this.connection = null;
        this.process = null;
      });

      const spawnErrorPromise = new Promise<never>((_, reject) => {
        this.process!.once("error", (err) => {
          reject(new Error(`Failed to start agent process: ${err.message}`));
        });
      });

      const stream = ndJsonStream(
        Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>
      );

      const client: Client = {
        requestPermission: async (
          params: RequestPermissionRequest
        ): Promise<RequestPermissionResponse> => {
          logger.info("Permission request", params);
          const allowOption = params.options.find(
            (opt) => opt.kind === "allow_once" || opt.kind === "allow_always"
          );
          if (allowOption) {
            logger.info(`Auto-approving with option: ${allowOption.optionId}`);
            return {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            };
          }
          logger.warn("No allow option found, cancelling");
          return { outcome: { outcome: "cancelled" } };
        },
        sessionUpdate: async (params: SessionNotification): Promise<void> => {
          const updateType = params.update?.sessionUpdate ?? "unknown";
          logger.debug(`Session update: ${updateType}`);
          if (updateType === "agent_message_chunk") {
            logger.debug("Chunk received", params.update);
          }
          if (updateType === "available_commands_update") {
            const update = params.update as {
              availableCommands: AvailableCommand[];
            };
            if (this.sessionMetadata) {
              this.sessionMetadata.commands = update.availableCommands;
            } else {
              this.pendingCommands = update.availableCommands;
            }
            logger.info(`Commands updated: ${update.availableCommands.length}`);
          }
          try {
            this.sessionUpdateListeners.forEach((cb) => cb(params));
          } catch (error) {
            logger.error("Error in session update listener", error);
          }
        },
      };

      this.connection = new ClientSideConnection(() => client, stream);

      const initPromise = this.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "vscode-acp",
          version: "0.0.1",
        },
      });

      const initResponse = await Promise.race([initPromise, spawnErrorPromise]);

      this.setState("connected");
      return initResponse;
    } catch (error) {
      this.setState("error");
      throw error;
    }
  }

  async newSession(workingDirectory: string): Promise<NewSessionResponse> {
    if (!this.connection) {
      throw new Error("Not connected");
    }

    const response = await this.connection.newSession({
      cwd: workingDirectory,
      mcpServers: [],
    });

    this.currentSessionId = response.sessionId;
    this.sessionMetadata = {
      modes: response.modes ?? null,
      models: response.models ?? null,
      commands: this.pendingCommands,
    };
    this.pendingCommands = null;

    return response;
  }

  getSessionMetadata(): SessionMetadata | null {
    return this.sessionMetadata;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    await this.connection.setSessionMode({
      sessionId: this.currentSessionId,
      modeId,
    });

    if (this.sessionMetadata?.modes) {
      this.sessionMetadata.modes.currentModeId = modeId;
    }
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    await this.connection.unstable_setSessionModel({
      sessionId: this.currentSessionId,
      modelId,
    });

    if (this.sessionMetadata?.models) {
      this.sessionMetadata.models.currentModelId = modelId;
    }
  }

  async sendMessage(message: string): Promise<PromptResponse> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    try {
      const response = await this.connection.prompt({
        sessionId: this.currentSessionId,
        prompt: [{ type: "text", text: message }],
      });
      logger.debug("Prompt completed", response);
      return response;
    } catch (error) {
      logger.error("Prompt error", error);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      return;
    }

    await this.connection.cancel({
      sessionId: this.currentSessionId,
    });
  }

  dispose(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
    this.currentSessionId = null;
    this.sessionMetadata = null;
    this.pendingCommands = null;
    this.setState("disconnected");
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateChangeListeners.forEach((cb) => cb(state));
    }
  }
}
