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

  /**
   * Fetches the Minecraft server version manifest.
   */
  export async function getServerVersions(): Promise<VersionManifest> {
    const response = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
    const data = await response.json();
    return data;
  }

  /**
   * Fetches the available Forge versions for a given Minecraft version.
   * @returns An array of Forge versions.
   */
  export async function getForgeVersions(minecraftVersion: string): Promise<string[]> {

    if (minecraftVersion === "latest") {
      const versions = await getServerVersions();
      minecraftVersion = versions.latest.release;
    }
    
    const url = `https://files.minecraftforge.net/net/minecraftforge/forge/index_${minecraftVersion}.html`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Forge versions: ${response.statusText}`);
    }
    const html = await response.text();
    const versionPattern = new RegExp(`forge-${minecraftVersion}-([\\d.]+)-installer\\.jar`, 'g');
    const versions = new Set<string>();
    let match;
    while ((match = versionPattern.exec(html)) !== null) {
      versions.add(match[1]);
    }
    return Array.from(versions);
  }

  /**
   * Fetches the Minecraft server data for a given version.
   * @param version The version to fetch data for.
   * @returns The version data.
   */
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