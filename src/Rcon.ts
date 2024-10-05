import net from "net";

/**
 * RCON class for connecting to a Minecraft RCON server
 */
export default class RCON {
  private socket: net.Socket;
  private requestId: number;
  private responseBuffer: Buffer | null;

  constructor() {
    throw new Error("Not yet implemented");
    this.socket = new net.Socket();
    this.requestId = 0; // Increment with each request
    this.responseBuffer = null; // Buffer to collect fragmented responses
  }

  /**
   * Connects to the RCON server
   * @param host - Hostname or IP of the RCON server
   * @param port - Port number of the RCON server
   * @param password - RCON password for authentication
   * @returns Promise that resolves when authenticated
   */
  public connect(host: string, port: number, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(port, host, () => {
        console.log("Connected to RCON server");
        
        // Send the auth packet after connecting
        this.sendPacket(this.requestId++, 3, password)
          .then((response) => {
            if (response.id === -1) {
              reject(new Error("Authentication failed"));
            } else {
              resolve();
            }
          })
          .catch(reject);
      });

      this.socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  public async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.end(() => {
        console.log("Disconnected from RCON server");
        resolve();
      });

      this.socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Sends a command to the RCON server
   * @param command - Command to execute on the server
   * @returns Promise that resolves with the command response
   */
  public async send(command: string): Promise<string> {
    return this.sendPacket(this.requestId++, 2, command).then((response) => {
      return response.body;
    });
  }

  /**
   * Sends a packet to the RCON server
   * @param id - Request ID
   * @param type - Packet type (3 for auth, 2 for command)
   * @param body - Packet body (auth password or command)
   * @returns Promise that resolves with the server's response
   */
  private async sendPacket(id: number, type: number, body: string): Promise<{ id: number; body: string }> {
    return new Promise((resolve, reject) => {
      const packet = this.createPacket(id, type, body);
      
      this.socket.write(packet);

      const onData = (data: Buffer) => {
        this.handleResponse(data)
          .then(resolve)
          .catch(reject);
      };

      // Bind to 'data' event once for the next incoming data packet
      this.socket.once("data", onData);

      this.socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Handles receiving responses from the server, buffering if necessary
   * @param data - Incoming data from the server
   * @returns Promise that resolves with the full response data
   */
  private async handleResponse(data: Buffer): Promise<{ id: number; body: string }> {
    return new Promise((resolve, reject) => {
      // Append the received data to the buffer
      if (this.responseBuffer) {
        this.responseBuffer = Buffer.concat([this.responseBuffer, data]);
      } else {
        this.responseBuffer = data;
      }

      // Ensure we have at least 12 bytes for a valid packet (header size)
      if (this.responseBuffer.length >= 12) {
        const length = this.responseBuffer.readInt32LE(0); // Total packet length
        if (this.responseBuffer.length >= length + 4) {
          const id = this.responseBuffer.readInt32LE(4);
          const body = this.responseBuffer.toString("utf-8", 12, length + 2); // Extract body
          
          // Reset the buffer for the next packet
          this.responseBuffer = null;
          resolve({ id, body });
        }
      } else {
        // Keep waiting for more data if the packet isn't complete yet
        reject(new Error("Incomplete packet received"));
      }
    });
  }

  /**
   * Creates an RCON packet with the specified parameters
   * @param id - Request ID
   * @param type - Packet type (3 for auth, 2 for command)
   * @param body - Packet body (auth password or command)
   * @returns Buffer containing the packet
   */
  private createPacket(id: number, type: number, body: string): Buffer {
    const length = Buffer.byteLength(body) + 14;
    const buffer = Buffer.alloc(length);

    buffer.writeInt32LE(length - 4, 0); // Packet length
    buffer.writeInt32LE(id, 4); // Request ID
    buffer.writeInt32LE(type, 8); // Packet type
    buffer.write(body, 12, "utf-8"); // Body
    buffer.writeInt16LE(0, length - 2); // Null-terminated

    return buffer;
  }
}
