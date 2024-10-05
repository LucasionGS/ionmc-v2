import fs from "fs";
import fsp from "fs/promises";
import Path from "path";
import * as pty from "node-pty";
import { wait } from "../Utilities";
import Server from "./Server";
import os from "os";

/**
 * Represents a Forge minecraft server.
 * @experimental
 */
class ForgeServer extends Server {
  
  public async start() {
    
    const isUnix = os.platform() !== "win32";
    const runner = isUnix ? "run.sh" : "run.bat";
    let runnerData = await fsp.readFile(Path.join(this.path, runner), "utf-8");
    runnerData = runnerData.replace(/^.*java\s/gm, this.javaPath + " ");
    await fsp.writeFile(Path.join(this.path, runner), runnerData);
    
    const parameterData = [
      `-Xms${this.memory[0]}M`,
      `-Xmx${this.memory[1]}M`,
    ].join(" ");

    await fsp.writeFile(Path.join(this.path, "user_jvm_args.txt"), parameterData);
    
    // Start the server
    this.ptyProcess = pty.spawn(Path.join(this.path, runner), [
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
  
  public async installServer() {
    const dlUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.16/forge-1.21.1-52.0.16-installer.jar";

    const rnd = Math.floor(Math.random() * 1000000).toString(16);
    const tmp = `${os.tmpdir()}/${rnd}_forge-installer.jar`;
    // Download the server jar
    const stream = fs.createWriteStream(tmp);
    const buf = Buffer.from(await fetch(dlUrl).then(res => res.arrayBuffer()));
    stream.write(buf);
    stream.end();

    return new Promise<void>((resolve, reject) => {
      stream.on("finish", async () => {
        pty.spawn(this.javaPath, ["-jar", tmp, "--installServer", this.path], {
          name: "xterm-color",
          cols: 80,
          rows: 30,
          cwd: this.path
        });

        let checks = 0;
        while (checks < 15) {
          await wait(1000);
          const files = await fsp.readdir(this.path).then(files => files).catch(() => []);
          let serverJar: string | undefined;
          if ((serverJar = files.find(f => f.endsWith(".jar"))) && files.find(f => f === "user_jvm_args.txt")) {
            // fsp.rename(Path.join(this.path, serverJar), Path.join(this.path, "server.jar"));
            this.jarFile = serverJar;
            await fsp.rm(tmp);
            return resolve();
          }
          checks++;
        }
        await fsp.rm(tmp);
        return reject("Server not installed. Timeout after 15 seconds.");
      });
      stream.on("error", async (err) => {
        await fsp.rm(tmp);
        reject(err);
      });
    });
  }

  public getDefaultJarFile(): string {
    try {
      const jar = fs.readdirSync(this.path).find(f => f.endsWith(".jar"));
      if (jar) return jar;
    } catch (error) {
      return super.getDefaultJarFile();
    }
    throw new Error("No jar file found in server directory");
  }
}

export default ForgeServer;