import fs from "node:fs";
import fsp from "node:fs/promises";
import Path from "node:path";
import * as pty from "node-pty";
import { wait } from "../Utilities";
import Server from "./Server";
import os from "node:os";
import MinecraftApi from "../MinecraftApi";

/**
 * Represents a Forge minecraft server.
 * @experimental
 */
export class ForgeServer extends Server {

  protected forgeVersion?: string;

  public setForgeVersion(version: string) {
    this.forgeVersion = version;
  }
  
  public async start() {
    const isUnix = os.platform() !== "win32";
    const runner = isUnix ? "run.sh" : "run.bat";
    let runnerData = await fsp.readFile(Path.join(this.path, runner), "utf-8");
    runnerData = runnerData.replace(/^.*java\s/gm, this.javaPath + " ");
    await fsp.writeFile(Path.join(this.path, runner), runnerData);
    
    const parameterData = [
      "-Dterminal.jline=false", // Disable colored output
      `-Xms${this.memory[0]}M`,
      `-Xmx${this.memory[1]}M`,
    ].join(" ");

    await fsp.writeFile(Path.join(this.path, "user_jvm_args.txt"), parameterData);
    
    // Start the server
    this.ptyProcess = pty.spawn(Path.join(this.path, runner), [
      "--nogui"
    ], {
      name: "xterm-color",
      cwd: this.path,
      env: process.env,
    });

    this.attachPtyEvents(this.ptyProcess);
  }

  public static parseData(data: string): Server.ParsedData {
    // Example:
    // [14:47:20] [Worker-Main-2/INFO]: Preparing spawn area: 71%
    const format = /\[(\d+:\d+:\d+)\] \[(.+?)\/(\w+)\](?: \[.+?\/\w*\])?: (.+)/;
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
  
  public async installServer(opts?: Server.InstallOptions) {
    opts ??= {};
    
    const versionData = await MinecraftApi.getServerData(this.version ?? "latest");
    this.version = versionData.id;

    if (!this.forgeVersion || this.forgeVersion === "latest") {
      const versions = await MinecraftApi.getForgeVersions(this.version);
      this.forgeVersion = versions[0];
    }
    
    const dlUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${this.version}-${this.forgeVersion}/forge-${this.version}-${this.forgeVersion}-installer.jar`;

    const rnd = Math.floor(Math.random() * 1000000).toString(16);
    const tmp = `${os.tmpdir()}/${rnd}_forge-installer.jar`;
    // Download the server jar
    const stream = fs.createWriteStream(tmp);

    const buf = Buffer.from(await fetch(dlUrl).then(res => res.arrayBuffer()));
    stream.write(buf);
    stream.end();

    return new Promise<void>((resolve, reject) => {
      stream.on("finish", async () => {
        const term = pty.spawn(this.javaPath, ["-jar", tmp, "--installServer"], {
          name: "xterm-color",
          cwd: this.path
        });

        term.onExit(async () => {
          let checks = 0;
          while (checks < 15) {
            await wait(1000);
            const files = await fsp.readdir(this.path).then(files => files).catch(() => []);
            let serverJar: string | undefined;
            if ((serverJar = files.find(f => f.endsWith("run.sh"))) && files.find(f => f === "user_jvm_args.txt")) {
              this.jarFile = serverJar;
              await fsp.rm(tmp);
              return resolve();
            }
            checks++;
          }
          await fsp.rm(tmp);
          return reject("Server not installed. Timeout after 15 seconds.");
        });
      });
      stream.on("error", async (err) => {
        await fsp.rm(tmp);
        reject(err);
      });
    });
  }

  public getDefaultJarFile(): string {
    const isUnix = os.platform() !== "win32";
    const runner = isUnix ? "run.sh" : "run.bat";
    return runner;
    // try {
    //   const jar = fs.readdirSync(this.path).find(f => f.endsWith(".jar"));
    //   if (jar) return jar;
    // } catch (error) {
    //   return super.getDefaultJarFile();
    // }
    // throw new Error("No jar file found in server directory");
  }

  public getServerJarPath(): string {
    return `${this.path}/${this.jarFile}`;
  }

  public async listAvailableMods() {
    const modsAvailable = Path.join(this.path, "modsavailable");
    await fsp.mkdir(modsAvailable, { recursive: true });
    const available = await fsp.readdir(modsAvailable);

    return available;
  }

  public async listEnabledMods() {
    const modsEnabled = Path.join(this.path, "mods");
    await fsp.mkdir(modsEnabled, { recursive: true });
    const enabled = await fsp.readdir(modsEnabled);

    return enabled;
  }
  
  public async listMods() {
    return {
      available: await this.listAvailableMods(),
      enabled: await this.listEnabledMods()
    };
  }

  public async enableMods(...mods: string[]) {
    const modsAvailable = Path.join(this.path, "modsavailable");
    const modsEnabled = Path.join(this.path, "mods");
    await fsp.mkdir(modsAvailable, { recursive: true });
    await fsp.mkdir(modsEnabled, { recursive: true });
    for (const mod of mods) {
      if (!fsp.stat(Path.join(modsAvailable, mod)).then(() => true).catch(() => false)) {
        throw new Error(`Mod ${mod} not found in modsavailable directory`);
      }
      await fsp.rename(Path.join(modsAvailable, mod), Path.join(modsEnabled, mod));
    }
  }

  public async disableMods(...mods: string[]) {
    const modsAvailable = Path.join(this.path, "modsavailable");
    const modsEnabled = Path.join(this.path, "mods");
    await fsp.mkdir(modsAvailable, { recursive: true });
    await fsp.mkdir(modsEnabled, { recursive: true });
    for (const mod of mods) {
      if (!fsp.stat(Path.join(modsEnabled, mod)).then(() => true).catch(() => false)) {
        throw new Error(`Mod ${mod} not found in mods directory`);
      }
      await fsp.rename(Path.join(modsEnabled, mod), Path.join(modsAvailable, mod));
    }
  }

  /**
   * Install a mod from CurseForge. If fileId is null or not found, the latest file will be downloaded.  
   * It is possible for the specific fileId to not be available anymore for whatever reason, if that happens it will install the latest file of that mod.
   * @param modId CurseForge mod ID
   * @param fileId Specific file ID to download. If null or couldn't be found, the latest file will be downloaded
   * @param enable Whether to enable the mod after downloading
   * @returns The fileID of the downloaded mod. Check this against the fileId parameter to check if it downloaded the specific file or a different file.
   */
  public async installMod(modId: number, fileId: number | null = null, enable: boolean = true): Promise<number> {
    const makeUrl = (page: number = 0) => `https://www.curseforge.com/api/v1/mods/${modId}/files?pageIndex=${page}&pageSize=50&sort=dateCreated&sortDescending=true&removeAlphas=true`
    let pageIndex = 0;
    let { data, pagination: { pageSize, totalCount } } = await fetch(makeUrl(pageIndex)).then(res => res.json());
    const pages = Math.ceil(totalCount / pageSize);
    if (!data) throw new Error("Failed to fetch mod data");

    let first: any;
    let modData: any;
    do {
      if (!data) {
        ({ data } = await fetch(makeUrl(++pageIndex)).then(res => res.json()));
      }
      if (!first) first = data[0];
      modData = fileId ? data.find((d: any) => d.id == fileId) : data[0];

      if (!modData) {
        data = null;
      }
    }
    while (!data && pageIndex < (pages - 1));
    
    let id = modData.id.toString();
    let fileName: string = modData.fileName;
    let [slice1, slice2] = [id.slice(0, 4), id.slice(4)];
    while (slice2.startsWith("0")) {
      slice2 = slice2.slice(1);
    }
    const url = `https://mediafilez.forgecdn.net/files/${slice1}/${slice2}/${encodeURIComponent(fileName)}`;
    
    const tmp = `${os.tmpdir()}/${id}_mod.jar`;

    const stream = fs.createWriteStream(tmp);
    const buf = Buffer.from(await fetch(url).then(res => {
      if (!res.ok) {
        console.error(url);
        throw new Error(`Failed to download mod: ${res.status} ${res.statusText}`);
      }
      return res.arrayBuffer();
    }));
    stream.write(buf);
    stream.end();

    return new Promise<number>((resolve, reject) => {
      stream.on("finish", async () => {
        const modsAvailable = Path.join(this.path, "modsavailable");
        await fsp.mkdir(modsAvailable, { recursive: true });
        await fsp.cp(tmp, Path.join(modsAvailable, fileName));
        if (enable) {
          await this.enableMods(fileName);
        }
        resolve(id);
      });
      stream.on("error", async (err) => {
        await fsp.rm(tmp);
        reject(err);
      });
    });
  }
}

export default ForgeServer;
