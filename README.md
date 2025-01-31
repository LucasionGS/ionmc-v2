# IonMC
IonMC is a core of tools for creating, managing, and running Minecraft servers.

## Predesessor
[IonMC v2 is the successor to "mcserver-plug" aka IonMC v1](https://github.com/LucasionGS/mcserver-plug).
Where IonMC V1 is a combined CLI tool and library, but was primarily built as a CLI tool.  
IonMC v2 is a library only and acts as a core for other tools.

## Features
- Download, create, and run a server
  - Vanilla
  - Forge
- Set/Get properties to/from server.properties
- Install forge mods from Curseforge using modId and fileId
- Events on server output such as any data, player join, player leave, ready, etc.

## Pre-requisites
- Node.js v22 or higher
- Java 21 or higher `(Optional, but required for running the server)`

## Installation
Install it from NPM using the following command.
```bash
npm install ionmc-core
```

### Installing mods from Curseforge manifest file.
It is very simple to install mods from a manifest file, as it includes all the info needed to install the mods.

Here is an example of how to install mods from a manifest file.
```json
// manifest.json
{
  "files": [
    {
      "projectID": 111111,
      "fileID": 2222222
    },
    {
      "projectID": 111111,
      "fileID": 2222222
    }
  ]
}
```

```ts
const manifest = await fs.promises.readFile("manifest.json", "utf-8").then(JSON.parse);
for (let i = 0; i < manifest.files.length; i++) {
  const file = manifest.files[i];
  try {
    await server.installMod(file.projectID, file.fileID, true);
  } catch (error) {
    console.error(error);
  }
}
```
