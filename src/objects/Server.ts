import MinecraftApi from "../MinecraftApi";
import fs from "node:fs";
import fsp from "node:fs/promises";
import Path from "node:path";
import * as pty from "node-pty";
import EventEmitter from "node:events";
import rl from "node:readline";
import RCON from "../Rcon";
import { escapeHTML, wait } from "../Utilities";
import { Writable } from "node:stream";
import http from "node:http";
import url from "node:url";

/**
 * Represents a minecraft server.
 */
export class Server extends EventEmitter {
  public get name() {
    return Path.basename(this.path);
  }
  constructor(
    /**
     * Path for the root directory of the server.
     */
    path: string,

    /**
     * Name of the server jar file. Default is the value returned by `getDefaultJarFile`.
     */
    jarFile?: string
  ) {
    super({ captureRejections: true });
    this.path = Path.resolve(path);
    this.jarFile = jarFile ?? this.getDefaultJarFile();
  }

  public async ensurePathExists() {
    if (!await fsp.stat(this.path).then(() => true).catch(() => false)) {
      await fsp.mkdir(this.path, { recursive: true });
    }
  }

  public colorMode: Server.ColorMode = Server.ColorMode.Terminal;

  /**
   * Default color mode for this server. This can be overridden by handing it as an argument to the `toFormattedString` function.
   */
  public defaultColorMode?: Server.ColorMode;


  /**
   * Path for the root directory of the server.
   */
  public readonly path: string;

  public memory: [number, number] = [1024, 1024]
  /**
   * Sets the amount of memory allocated to the server.
   * @param memory The amount of memory to allocate to the server. Unit is in MB.
   */
  public setMemory(memory: number): this;
  /**
   * Sets the amount of memory allocated to the server.
   * @param min The minimum amount of memory to allocate to the server. Unit is in MB.
   * @param max The maximum amount of memory to allocate to the server. Unit is in MB.
   */
  public setMemory(min: number, max: number): this;
  public setMemory(min: number, max?: number): this {
    this.memory = [min, max ?? min];
    return this;
  }

  public version?: string;
  public setVersion(version: string): this {
    this.version = version;
    return this;
  }

  public get _static() {
    return this.constructor as typeof Server;
  }

  /**
   * Path to the java executable.
   */
  public javaPath: string = "java";

  /**
   * Sets the path to the java executable.
   * @returns 
   */
  public setJavaPath(path: string): this {
    this.javaPath = path;
    return this;
  }

  public jarFile: string;

  public getDefaultJarFile(): string {
    return "server.jar";
  }

  public getServerJarPath(): string {
    return `${this.path}/${this.jarFile}`;
  }

  public getServerPropertiesPath(): string {
    return `${this.path}/server.properties`;
  }

  public async checkInstalled(): Promise<boolean> {
    return await fsp.stat(this.getServerJarPath()).then(() => true).catch(() => false);
  }


  /**
   * Install the server based on the version.  
   * This function will be called when the server is installed or updated.
   * 
   * Classes that extend this class should override this function if the server jar is different from default. (e.g. Forge, Fabric, Spigot, etc.)
   */
  public async installServer(opts?: Server.InstallOptions) {
    opts ??= {};
    const versionData = await MinecraftApi.getServerData(this.version ?? "latest");
    this.version = versionData.id;

    opts.progressStream?.write(`Installing server ${versionData.downloads.server.url}`);

    const downloadUrl = versionData.downloads.server.url;
    const parsedUrl = url.parse(downloadUrl);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.path,
      method: "GET"
    };

    const stream = fs.createWriteStream(this.getServerJarPath());

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        throw new Error(`Failed to download server jar: ${res.statusMessage}`);
      }

      const total = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;

      res.on("data", (chunk) => {
        downloaded += chunk.length;
        // const percentComplete = (downloaded / total) * 100;
        // opts.progressStream?.write(`Download progress: ${percentComplete.toFixed(2)}%`);
        opts.progressStream?.write(`Progress: ${downloaded}/${total}`);
        stream.write(chunk);
      });

      res.on("end", () => {
        stream.end();
      });
    });

    req.on("error", (err) => {
      throw new Error(`Network error while downloading server jar: ${err.message}`);
    });

    req.end();

    return new Promise<void>((resolve, reject) => {
      stream.on("finish", () => {
        resolve();
      });
      stream.on("error", (err) => {
        reject(err);
      });
    });
  }

  public properties: Record<string, string> = {};

  public setProperty(key: string, value: string): this {
    this.properties[key] = value;
    return this;
  }

  public getProperty(key: string): string | undefined {
    return this.properties[key];
  }

  public async saveProperties() {
    const stream = fs.createWriteStream(this.getServerPropertiesPath());

    stream.write("# Minecraft server properties\n");
    stream.write("# EDITED BY IONMC\n");
    stream.write("# (File modification datestamp)\n");
    stream.write(`# ${new Date().toISOString()}\n`);
    stream.write("# \n");

    for (const key in this.properties) {
      stream.write(`${key}=${this.properties[key]}\n`);
    }

    stream.end();

    return new Promise<void>((resolve, reject) => {
      stream.on("finish", () => {
        resolve();
      });
      stream.on("error", (err) => {
        reject(err);
      });
    });
  }

  public static async parseProperties(data: string) {
    const properties: Record<string, string> = {};
    const lines = data.split("\n");
    for (const line of lines) {
      const [key, value] = line.split("=");
      properties[key] = value;
    }
    return properties;
  }

  public async loadProperties() {
    const spPath = this.getServerPropertiesPath();
    if (await fsp.stat(spPath).then(() => true).catch(() => false)) {
      const data = await fsp.readFile(spPath, "utf-8");
      this.properties = await Server.parseProperties(data);
    }
    else {
      this.properties = {};
      console.error("Server properties file not found.");
    }
  }

  public ptyProcess?: pty.IPty;
  public stdout: Server.ParsedData[] = [];
  // public stderr = new WriteStream(0);

  /**
   * Start the server. This will start the server process based on the settings it was given and attach events to it.
   */
  public async start() {
    // Start the server
    this.ptyProcess = pty.spawn(this.javaPath, [
      `-Xms${this.memory[0]}M`,
      `-Xmx${this.memory[1]}M`,
      "-jar",
      this.getServerJarPath(),
      "--nogui"
    ], {
      name: "xterm-color",
      cwd: this.path,
      env: process.env,
    });

    this.attachPtyEvents(this.ptyProcess);
  }

  /**
   * Restart the server. This will stop the server and start it again.
   */
  public async restart() {
    await this.stop();
    await wait(1000);
    return await this.start();
  }

  /**
   * Attach events to the pty process. This ensures the server data is parsed and emitted as events.
   */
  protected attachPtyEvents(ptyProcess: pty.IPty) {
    let partial = "";
    ptyProcess.onData((data) => {
      // data = data.replace(/\r/g, "");
      // console.log("RAW:", JSON.stringify(data));
      
      if (data.endsWith("\n") || data.endsWith("\r")) {
        data = partial + data;
        partial = "";
      }
      else {
        partial += data;
        return;
      }
      // Example:
      // Done (25.931s)! For help, type "help"
      const parsed = this._static.parseData(data);
      this.checkEvents(parsed);
      this.stdout.push(parsed);
      this.emit("data", parsed);
    });

    ptyProcess.onExit((code) => {
      this.ready = false;
      this.emit("exit", code.exitCode);
    });
  }

  /**
   * Check for events in the server data and execute the corresponding event.
   */
  private checkEvents(data: string | Server.ParsedData) {
    if (typeof data === "string") {
      data = this._static.parseData(data);
    }

    const msg = data.message;
    let result: RegExpMatchArray | null;

    if (result = msg.match(/(.*?) joined the game/)) {
      this.players.add(result[1]);
      this.emit("join", result[1]);
    }
    else if (result = msg.match(/(.*?) left the game/)) {
      this.players.delete(result[1]);
      this.emit("leave", result[1]);
    }
    else if (result = msg.match(/Done \(\d+\.\d+s\)! For help, type "help"/)) {
      this.emit("ready", result[1]);
      this.ready = true;
    }
    else if (data.type == "minecraft" && data.thread == "Main" && (result = msg.match(/eula.txt/))) {
      this.emit("eula", "EULA not accepted. Please set `eula=true` in eula.txt.");
    }
  }

  /**
   * Parses the data from the server.
   */
  public static parseData(data: string): Server.ParsedData {
    // Example:
    // [14:47:20] [Worker-Main-2/INFO]: Preparing spawn area: 71%
    const format = /\[(\d+:\d+:\d+)\] \[(.+?)\/(\w+)\]: (.+)/;
    const match = data.match(format);
    if (match) {
      const [, time, thread, type, message] = match;
      return {
        time,
        thread,
        type,
        message: message.trim()
      };
    }
    return {
      message: data.trim()
    };
  }

  /**
   * Formats the data to a readable string. Colors are used to differentiate the different parts of the data. Uses the default color mode for this server if set and not passed as an argument.
   */
  private static toFormattedString(data: string | Server.ParsedData, colorMode?: Server.ColorMode): string {
    colorMode ??= Server.defaultColorMode;

    if (typeof data === "string") {
      data = this.parseData(data);
    }

    if (!data.time) {
      const date = new Date();
      data.time = `${date.getHours().toString().padStart(2, "0")
        }:${date.getMinutes().toString().padStart(2, "0")
        }:${date.getSeconds().toString().padStart(2, "0")
        }`;
    }

    if (!data.thread) {
      data.thread = "IonMC Main";
    }

    if (!data.type) {
      data.type = "INFO";
    }

    switch (colorMode) {
      case Server.ColorMode.Terminal:
        return `\x1b[36m[${data.time}]\x1b[0m \x1b[32m[${data.thread}/${data.type}]\x1b[0m: ${data.message}`;
      case Server.ColorMode.HTML:
        return `<span style="color: #0099ff;">[${escapeHTML(data.time)}]</span> <span style="color: #00cc00;">[${escapeHTML(data.thread)}/${escapeHTML(data.type)}]</span>: ${escapeHTML(data.message)}`;
      default:
        return `[${data.time}] [${data.thread}/${data.type}]: ${data.message}`;
    }
  }

  /**
   * Write data to the server
   * @param data The data to write to the server.
   */
  public write(data: string) {
    this.ptyProcess?.write(data);
  }

  /**
   * Write a line of data to the server. This will append a newline character to the end of the data.
   * @param data The data to write to the server.
   */
  public writeLine(data: string) {
    this.ptyProcess?.write(data + "\n");
  }

  /**
   * Stop the server. This will send the `stop` command to the server and is equivalent to `server.writeLine("stop")`.
   */
  public async stop() {
    this.writeLine("stop");
    return new Promise<void>((resolve) => {
      this.once("exit", () => {
        resolve();
      });
    });
  }

  /**
   * Kill the server process.
   */
  public kill() {
    this.ptyProcess?.kill();
  }

  /**
   * List of players currently online on the server. Updated automatically when players join or leave the server.
   */
  public players: Set<string> = new Set();
  
  /**
   * Get a list of players currently online on the server. It checks using the `list` command.  
   * It will update the `players` property of the server.
   * @returns A promise that resolves with an array of player names.
   */
  public getPlayers() {
    return new Promise<string[]>((resolve, reject) => {
      const players: string[] = [];
      const dataHandler = (data: Server.ParsedData) => {
        const result = data.message.match(/There are \d+ of a max of \d+ players online:\s*(.*)/);
        if (result) {
          players.push(...result[1].split(",").map(a => a.trim()).filter(Boolean));
          this.players = new Set(players);
          this.off("data", dataHandler);
          resolve(players);
        }
      };

      this.on("data", dataHandler);
      this.writeLine("list");

      setTimeout(() => {
        this.off("data", dataHandler);
        reject(new Error("Timeout"));
      }, 2000);
    })
  }

  private _rlInterface?: rl.Interface;

  /**
   * Log data from the server to a stream.
   * @param data The data to log.
   * @param stdout The stream to log the data to. Default is process.stdout.
   */
  public logger(data: string | Server.ParsedData, stdout = process.stdout) {
    const formatted = this._static.toFormattedString(data);
    stdout.write(formatted + "\n");
  }

  /**
   * Create a logger function that can be used to log data from the server to a stream.
   * @param stdout The stream to log the data to. Default is process.stdout.
   * @returns 
   */
  public createLogger(stdout = process.stdout) {
    return (data: string | Server.ParsedData) => this.logger(data, stdout);
  }
  
  /**
   * Attach a readstream and writestream to the server. This will allow a readline interface to be created in a terminal environment.
   * 
   * Default is process.stdin and process.stdout.
   * @param stdin Readstream to attach to the server.
   * @param stdout Writestream to attach to the server.
   * @param middleware Middleware function to handle the input before sending it to the server. Return false to prevent the input from being sent to the server. Return a string to change the input.
   */
  public attach(stdin = process.stdin, stdout = process.stdout, middleware?: Server.AttachMiddleware, opt?: {
    /**
     * Keep the streams attached to the server even after the server is stopped.
     */
    keepAttached?: boolean;
  }) {
    opt ??= {};

    this._rlInterface = rl.createInterface({
      input: stdin,
      output: stdout
    });

    this._rlInterface.on("line", (line) => {
      if (middleware) {
        const result = middleware(line);
        if (result === false) return;
        if (typeof result === "string") {
          line = result;
        }
      }

      this.writeLine(line);
    });

    const dataListener = this.createLogger(stdout);

    const unsubExit = opt.keepAttached ? null : this.ptyProcess?.onExit((code) => {
      this.detach();
      this.off("data", dataListener);
      unsubExit?.dispose();
    });

    this.detachFunc = () => {
      this.off("data", dataListener);
      unsubExit?.dispose();
      this.detachFunc = null;
    }

    this.on("data", dataListener);
  }

  private detachFunc: null | (() => void) = null; // Set programmatically

  /**
   * Detach the readline interface from the server.
   */
  public detach() {
    this.detachFunc?.();
    this._rlInterface?.close();
    this._rlInterface = undefined;
  }

  /**
   * RCON interface for the server. Undefined if not connected.
   */
  public rcon?: RCON;

  /**
   * Connect to the server's RCON interface. Requires the `enable-rcon` and `rcon.password` properties to be set in the server.properties file.
   * 
   * @throws Error if the RCON password is not found in the server.properties file.
   */
  public async connectRcon() {
    const properties = await Server.parseProperties(fs.readFileSync(this.getServerPropertiesPath(), "utf-8"));

    const host = properties["server-ip"] || "localhost";
    const port = parseInt(properties["rcon.port"] ?? "25575");
    const enabled = properties["enable-rcon"];
    const password = properties["rcon.password"];

    if (!enabled || !password) {
      throw new Error("RCON password not found in server.properties. Please set both the `enable-rcon` and `rcon.password` properties in the server.properties file.");
    }

    this.rcon = new RCON();
    await this.rcon.connect(host, port, password);

    return this.rcon;
  }

  /**
   * Disconnect from the server's RCON interface.
   */
  public disconnectRcon() {
    this.rcon?.disconnect();
    this.rcon = undefined;
  }

  /**
   * Accept the EULA for the server. This will set `eula=true` in the eula.txt file.
   */
  public async acceptEula() {
    const eulaPath = Path.resolve(this.path, "eula.txt");
    if (await fsp.stat(eulaPath).then(() => true).catch(() => false)) {
      const eula = await fsp.readFile(eulaPath, "utf-8");
      if (!eula.match(/eula=true/)) {
        await fsp.writeFile(eulaPath, "eula=true");
      }
    }
    else {
      await fsp.writeFile(eulaPath, "eula=true");
    }
  }

  public async getOperators(): Promise<Server.Operator[]> {
    const opsPath = Path.resolve(this.path, "ops.json");
    if (await fsp.stat(opsPath).then(() => true).catch(() => false)) {
      const data = await fsp.readFile(opsPath, "utf-8");
      const players: Server.Operator[] = JSON.parse(data);
      return players;
    }
    throw new Error("Ops file not found.");
  }

  private ready: boolean = false;

  public isRunning() {
    return !!this.ptyProcess;
  }

  public isReady() {
    return this.ready;
  }

  public getStatus() {
    if (this.isRunning()) return this.isReady() ? "running" : "starting";
    else return "offline";
  }
}

export interface Server {
  // Events

  // Data
  emit(event: "data", data: Server.ParsedData): boolean;
  on(event: "data", listener: (data: Server.ParsedData) => void): this;
  once(event: "data", listener: (data: Server.ParsedData) => void): this;
  off(event: "data", listener: (data: Server.ParsedData) => void): this;

  // Exit
  emit(event: "exit", code: number): boolean;
  on(event: "exit", listener: (code: number) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  off(event: "exit", listener: (code: number) => void): this;

  // Error
  emit(event: "error", error: Error): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;

  // Ready
  emit(event: "ready", message: string): boolean;
  on(event: "ready", listener: (message: string) => void): this;
  once(event: "ready", listener: (message: string) => void): this;
  off(event: "ready", listener: (message: string) => void): this;

  // Player join
  emit(event: "join", player: string): boolean;
  on(event: "join", listener: (player: string) => void): this;
  once(event: "join", listener: (player: string) => void): this;
  off(event: "join", listener: (player: string) => void): this;

  // Player leave
  emit(event: "leave", player: string): boolean;
  on(event: "leave", listener: (player: string) => void): this;
  once(event: "leave", listener: (player: string) => void): this;
  off(event: "leave", listener: (player: string) => void): this;

  // EULA not accepted
  emit(event: "eula", message: string): boolean;
  on(event: "eula", listener: (message: string) => void): this;
  once(event: "eula", listener: (message: string) => void): this;
  off(event: "eula", listener: (message: string) => void): this;
}

export namespace Server {
  export enum ColorMode {
    /**
     * Uses ANSI escape codes.
     */
    Terminal,
    /**
     * Uses HTML span tags with style.
     */
    HTML,
    /**
     * No color formatting.
     */
    None
  }

  /**
   * Default color mode for all servers. This can be overridden by setting the `defaultColorMode` property of the server instance, or handing it as an argument to the `toFormattedString` function.
   */
  export let defaultColorMode: Server.ColorMode = Server.ColorMode.Terminal;

  export interface ParsedData {
    message: string;
    time?: string;
    thread?: string;
    type?: string;
  }

  export type AttachMiddleware = (data: string) => string | boolean | void;

  export interface InstallOptions {
    progressStream?: ProgressStream;
  }

  export interface Operator {
    uuid: string,
    name: string,
    level: number,
    bypassesPlayerLimit: boolean
  }

  export class ProgressStream extends Writable {
    constructor() {
      super();
    }

    _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      this.emit("data", chunk.toString());
      callback();
    }
  }
}


export default Server;
