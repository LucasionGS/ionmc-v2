import MinecraftApi from "../MinecraftApi";
import fs from "fs";
import fsp from "fs/promises";
import Path from "path";
import * as pty from "node-pty";
import { WriteStream } from "tty";
import EventEmitter from "events";
import rl from "readline";
import RCON from "../Rcon";
import { wait } from "../Utilities";

/**
 * Represents a minecraft server.
 */
class Server extends EventEmitter {
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

  public name: string = "Server";
  public setName(name: string): this {
    this.name = name;
    return this;
  }

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
  public async installServer() {
    const versionData = await MinecraftApi.getServerData(this.version ?? "latest");
    this.version = versionData.id;
    console.log(`Installing server ${versionData.downloads.server.url}`);

    // Download the server jar
    const stream = fs.createWriteStream(this.getServerJarPath());
    const buf = Buffer.from(await fetch(versionData.downloads.server.url).then(res => res.arrayBuffer()));
    stream.write(buf);
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
  public stdout: ParsedData[] = [];
  // public stderr = new WriteStream(0);

  public async start() {
    // Start the server
    this.ptyProcess = pty.spawn(this.javaPath, [
      `-Xms${this.memory[0]}M`,
      `-Xmx${this.memory[1]}M`,
      "-jar",
      this.getServerJarPath(),
      "nogui"
    ], {
      name: "xterm-color",
      // cols: 80,
      // rows: 30,
      cwd: this.path,
      env: process.env,
    });

    this.attachPtyEvents(this.ptyProcess);
  }

  protected attachPtyEvents(ptyProcess: pty.IPty) {
    ptyProcess.onData((data) => {
      // Example:
      // Done (25.931s)! For help, type "help"
      const parsed = Server.parseData(data);
      this.checkEvents(parsed);
      this.stdout.push(parsed);
      this.emit("data", parsed);
    });

    ptyProcess.onExit((code) => {
      this.emit("exit", code.exitCode);
    });
  }

  private checkEvents(data: string | ParsedData) {
    if (typeof data === "string") {
      data = Server.parseData(data);
    }

    const msg = data.message;
    let result: RegExpMatchArray | null;

    if (result = msg.match(/(.*?) joined the game/)) {
      this.emit("join", result[1]);
    }
    else if (result = msg.match(/(.*?) left the game/)) {
      this.emit("leave", result[1]);
    }
    else if (result = msg.match(/Done \(\d+\.\d+s\)! For help, type "help"/)) {
      this.emit("ready");
    }
  }

  private static parseData(data: string): ParsedData {
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
        message
      };
    }
    return {
      message: data
    };
  }

  /**
   * Formats the data to a readable string. Colors are used to differentiate the different parts of the data. Uses the default color mode for this server if set and not passed as an argument.
   */
  private toFormattedString(data: string | ParsedData, colorMode?: Server.ColorMode): string {
    return Server.toFormattedString(data, this.colorMode ?? colorMode);
  }

  /**
   * Formats the data to a readable string. Colors are used to differentiate the different parts of the data.
   * @returns 
   */
  private static toFormattedString(data: string | ParsedData, colorMode?: Server.ColorMode): string {

    colorMode ??= Server.defaultColorMode;

    if (typeof data === "string") {
      data = Server.parseData(data);
    }

    if (!data.time) {
      const date = new Date();
      data.time = `${date.getHours().toString().padStart(2, "0")
        }:${date.getMinutes().toString().padStart(2, "0")
        }:${date.getSeconds().toString().padStart(2, "0")
        }`;
    }

    if (!data.thread) {
      data.thread = "Main";
    }

    if (!data.type) {
      data.type = "INFO";
    }

    switch (colorMode) {
      case Server.ColorMode.Terminal:
        return `\x1b[36m[${data.time}]\x1b[0m \x1b[32m[${data.thread}/${data.type}]\x1b[0m: ${data.message}`;
      case Server.ColorMode.HTML:
        return `<span style="color: #0099ff;">[${data.time}]</span> <span style="color: #00cc00;">[${data.thread}/${data.type}]</span>: ${data.message}`;
      default:
        return `[${data.time}] [${data.thread}/${data.type}]: ${data.message}`;
    }
  }

  public write(data: string) {
    this.ptyProcess?.write(data);
  }

  public writeLine(data: string) {
    this.ptyProcess?.write(data + "\n");
  }

  /**
   * Stop the server. This will send the `stop` command to the server and is equivalent to `server.writeLine("stop")`.
   */
  public stop() {
    this.writeLine("stop");
  }

  public kill() {
    this.ptyProcess?.kill();
  }

  public getPlayers() {
    return new Promise<string[]>((resolve, reject) => {
      const players: string[] = [];
      const dataHandler = (data: ParsedData) => {
        const result = data.message.match(/There are \d+ of a max of \d+ players online:\s*(.*)/);
        if (result) {
          players.push(...result[1].trim().split(", ").filter(Boolean));
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
   * Attach a readstream and writestream to the server. This will allow a readline interface to be created in a terminal environment.
   * 
   * Default is process.stdin and process.stdout.
   * @param stdin Readstream to attach to the server.
   * @param stdout Writestream to attach to the server.
   * @param middleware Middleware function to handle the input before sending it to the server. Return false to prevent the input from being sent to the server. Return a string to change the input.
   */
  public attach(stdin = process.stdin, stdout = process.stdout, middleware?: (data: string) => string | boolean | void) {
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

    const dataListener = (data: ParsedData): void => {
      stdout.write(
        this.toFormattedString(data) + "\n"
      );
    };

    const unsubExit = this.ptyProcess?.onExit((code) => {
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
   * Connect to the server's RCON interface.
   */
  public async connectRcon() {
    const properties = await Server.parseProperties(fs.readFileSync(this.getServerPropertiesPath(), "utf-8"));

    const host = properties["server-ip"] || "localhost";
    const port = parseInt(properties["rcon.port"] ?? "25575");
    const password = properties["rcon.password"];

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
}

interface Server {
  // Events

  // Data
  emit(event: "data", data: ParsedData): boolean;
  on(event: "data", listener: (data: ParsedData) => void): this;
  once(event: "data", listener: (data: ParsedData) => void): this;
  off(event: "data", listener: (data: ParsedData) => void): this;

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
  emit(event: "ready"): boolean;
  on(event: "ready", listener: () => void): this;
  once(event: "ready", listener: () => void): this;
  off(event: "ready", listener: () => void): this;

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
}

namespace Server {
  export enum ColorMode {
    Terminal,
    HTML,
    None
  }

  /**
   * Default color mode for all servers. This can be overridden by setting the `defaultColorMode` property of the server instance, or handing it as an argument to the `toFormattedString` function.
   */
  export let defaultColorMode: Server.ColorMode = Server.ColorMode.Terminal;
}

interface ParsedData {
  message: string;
  time?: string;
  thread?: string;
  type?: string;
}

export default Server;