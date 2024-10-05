import MinecraftApi from "./MinecraftApi";
import ForgeServer from "./objects/ForgeServer";
import Server from "./objects/Server";
import { wait } from "./Utilities";

(async () => {
  // const server = new Server("./tests/testserver");
  const server = new ForgeServer("./tests/forgeserver");
  await server.ensurePathExists();
  server.setName("Test Server");
  server.setMemory(2048);
  server.setVersion("latest");

  if (!await server.checkInstalled()) {
    await server.installServer()
      .then(() => console.log("Server installed"))
      .catch((err) => console.error(err)); 
  }

  await server.loadProperties();
  server.setProperty("enable-rcon", "true");
  await server.saveProperties();

  await server.start();
  server.attach();

  // server.attach();

  let players: string[] = [];
  
  server.on("ready", async () => {
    console.log("Server is ready!");

    server.attach(process.stdin, process.stdout, line => {
      if (line === "@detach") {
        server.detach();
        console.log("Detached from server. Stopping in 5 seconds");
        setTimeout(() => {
          server.writeLine("stop");
        }, 5000);
        return false;
      }
    });

    server.on("join", async (player) => {
      console.log("Player joined: ", player);
      players = await server.getPlayers();
      await wait(5000);
      server.writeLine(`say Welcome, ${player}! You are the ${players.length} player to join!`);
      await wait(1000);
      server.writeLine(`say You are about to get kicked in 5 seconds!`);
      await wait(5000);
      server.writeLine(`kick ${player} You have been kicked!`);

      await wait(1000);
      server.stop();
    });
  });

  server.on("exit", () => {
    console.log("Players before ending: ", players);
    process.exit(0);
  });
})();