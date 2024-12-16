import MinecraftApi from "./MinecraftApi";
import ForgeServer from "./objects/ForgeServer";
import Server from "./objects/Server";
import { wait } from "./Utilities";

(async () => {
  const server = new Server("./tests/testserver");
  // const server = new ForgeServer("./tests/forgeserver");
  await server.ensurePathExists();
  server.setMemory(2048);
  server.setVersion("latest");
  if (server instanceof ForgeServer) {
    server.setVersion("1.20.1");
    // server.setForgeVersion("54.0.6");
  }
  server.acceptEula();

  if (!await server.checkInstalled()) {
    const stream = new Server.ProgressStream();
    stream.on("data", console.log);
    await server.installServer({
      progressStream: stream
    })
      .then(() => console.log("Server installed"))
      .catch((err) => console.error(err)); 
  }

  if (server instanceof ForgeServer) {
    const { available, enabled } = await server.listMods();
    const mods = available.concat(enabled);

    if (!mods.includes("create-1.20.1-0.5.1.j.jar")) {
      await server.installMod(328085, null, true);
    }
  }

  await server.loadProperties();
  server.setProperty("enable-rcon", "true");
  server.setProperty("rcon.password", "safepass");
  await server.saveProperties();

  await server.start();
  const serverLog = server.createLogger(process.stdout);
  const attachMiddleware: Server.AttachMiddleware = (line => {
    if (line.startsWith("@")) {
      const [command, ...args] = line.slice(1).split(" ");
      if (command === "detach") {
        server.detach();
        console.log("Detached from server. Stopping in 5 seconds");
        setTimeout(() => {
          server.writeLine("stop");
        }, 5000);
      }

      if (command === "restart") {
        server.restart()
        // .then(() => {
        //   server.attach(process.stdin, process.stdout, attachMiddleware);
        // });
      }

      if (server instanceof ForgeServer) {
        if (command === "mods") {
          switch (args[0]) {
            case "enable": {
              let mod = args[1];
              if (!mod) {
                serverLog("No mod specified");
                break;
              }

              server.listAvailableMods().then(mods => {
                const found = mods.filter(m => m.startsWith(mod));
                if (found.length === 0) {
                  serverLog(`No match for available "${mod}" was found`);
                  return;
                }
                else if (found.length > 1) {
                  serverLog(`${mod} is ambigious, multiple matches found: ${found.join(", ")}`);
                  return;
                }

                mod = found[0];

                server.enableMods(mod);
              });

              break;
            }

            case "disable":{
              let mod = args[1];
              if (!mod) {
                serverLog("No mod specified");
                break;
              }

              server.listEnabledMods().then(mods => {
                const found = mods.filter(m => m.startsWith(mod));
                if (found.length === 0) {
                  serverLog(`No match for enabled "${mod}" was found`);
                  return;
                }
                else if (found.length > 1) {
                  serverLog(`${mod} is ambigious, multiple matches found: ${found.join(", ")}`);
                  return;
                }

                mod = found[0];

                server.disableMods(mod);
              });

              break;
            }

            default: {
              server.listEnabledMods().then(mods => {
                serverLog(mods.join(", "));
              });
              break;
            }
          }
        }
      }

      return false;
    }
  });

  server.attach(process.stdin, process.stdout, attachMiddleware, { keepAttached: true });
  
  server.on("ready", async () => {
    console.log("Server is ready!");

    server.on("join", async (player) => {
      console.log("Player joined: ", player);
      await wait(5000);
      server.writeLine(`say Welcome, ${player}!`);
      // await wait(1000);
      // server.writeLine(`say You are about to get kicked in 5 seconds!`);
      // await wait(5000);
      // server.writeLine(`kick ${player} You have been kicked!`);

      // await wait(1000);
      // server.stop();
    });

    try {
      const rcon = await server.connectRcon();
  
      const thing = await rcon.send("list");
  
      console.log("From RCON: ", thing);
    } catch (error) {
      console.error(error);
    }
  });

  server.on("exit", (code) => {
    console.log("Server exited", code);
    process.exit(0);
  });
})();