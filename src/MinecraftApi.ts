namespace MinecraftApi {
  export interface VersionManifest {
    latest: {
      release: string;
      snapshot: string;
    };
    versions: Version[];
  }

  export interface Version {
    id: string;
    type: string;
    url: string;
    time: string;
    releaseTime: string;
  }

  export interface VersionData {
    id: string;
    downloads: {
      server: {
        url: string;
        sha1: string;
        size: number;
      };
    };
  }
  
  export async function getServerVersions(): Promise<VersionManifest> {
    const response = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
    const data = await response.json();
    return data;
  }

  export async function getServerData(version: string | Version): Promise<VersionData> {
    let versionObj: Version | undefined;
    if (typeof version === "string") {
      const data = await getServerVersions();

      if (version === "latest") version = data.latest.release;
      if (version === "latest-snapshot") version = data.latest.snapshot;

      versionObj = data.versions.find((v: Version) => v.id === version);
    }
    else {
      versionObj = version;
    }
    if (!versionObj) {
      throw new Error(`Version ${versionObj} not found.`);
    }
    const versionResponse = await fetch(versionObj.url);
    return await versionResponse.json();
  }
}

export default MinecraftApi;