const { MonitorType } = require("./monitor-type");
const dgram = require("dgram");

class NtpMonitor extends MonitorType {
    /**
     * Unique identifier for this monitor type
     */
    name = "ntp";

    /**
     * Main execution logic for the NTP check
     * @param {Monitor} monitor Monitoring configuration
     * @param {Heartbeat} heartbeat Heartbeat object to record results
     * @param {UptimeKumaServer} server Server instance
     * @returns {Promise<void>}
     */
    async check(monitor, heartbeat, server) {
        return new Promise((resolve, reject) => {
            // Convert timeout from seconds to milliseconds (Default: 10s)
            const timeoutMs = (monitor.timeout || 10) * 1000;
            const client = dgram.createSocket("udp4");

            // Generate standard NTP Request Packet (48 bytes)
            // Settings: LI=0, VN=3 (NTP v3), Mode=3 (Client) -> 0x1b
            const ntpBuffer = Buffer.alloc(48);
            ntpBuffer[0] = 0x1b;

            const startTime = Date.now();

            // Handle network timeout or packet loss
            const timer = setTimeout(() => {
                cleanup();
                const timeoutError = new Error("NTP Timeout");
                heartbeat.status = 0;
                heartbeat.msg = "NTP Timeout (No response from server)";
                reject(timeoutError);
            }, timeoutMs);

            /**
             * Resource cleanup: Stop timer and close UDP socket
             */
            const cleanup = () => {
                clearTimeout(timer);
                try {
                    client.close();
                } catch (e) {
                    // Ignore socket close errors
                }
            };

            /**
             * Expected stratum level for the NTP server
             * @type {number}
             */
            this.expectedStratum = monitor.expectedStratum || null;

            client.on("message", (msg) => {
                const endTime = Date.now();
                const rtt = endTime - startTime;
                cleanup();

                try {
                    // --- Full Packet Analysis ---
                    // Index 1: Stratum level (1=Primary, 2=Secondary, etc.)
                    const stratum = msg.readUInt8(1);

                    // Check if the stratum matches the expected value
                    if (this.expectedStratum !== null && stratum !== this.expectedStratum) {
                        heartbeat.status = 0;
                        heartbeat.msg = `Stratum mismatch: Expected ${this.expectedStratum}, but got ${stratum}`;
                        reject(new Error(heartbeat.msg));
                        return;
                    }

                    // Index 40-43: Transmit Timestamp (Seconds part)
                    // NTP era starts at 1900-01-01. Offset to Unix era (1970-01-01) is 2,208,988,800s.
                    const seconds = msg.readUInt32BE(40) - 2208988800;
                    const serverDate = new Date(seconds * 1000);

                    // Record success status
                    heartbeat.status = 1;

                    // Detailed status message for the UI
                    heartbeat.msg = `OK - Stratum: ${stratum}, RTT: ${rtt}ms, ServerTime: ${
                        serverDate.toISOString().split(".")[0]
                    }Z`;

                    // Map RTT to Uptime Kuma's latency chart
                    heartbeat.ping = rtt;

                    resolve();
                } catch (e) {
                    heartbeat.status = 0;
                    heartbeat.msg = "Packet Parse Error: " + e.message;
                    reject(e);
                }
            });

            client.on("error", (err) => {
                cleanup();
                heartbeat.status = 0;
                heartbeat.msg = "UDP Communication Error: " + err.message;
                reject(err);
            });

            // Send the request to target host
            client.send(ntpBuffer, 0, 48, monitor.port || 123, monitor.hostname, (err) => {
                if (err) {
                    cleanup();
                    heartbeat.status = 0;
                    heartbeat.msg = "Send Failed: " + err.message;
                    reject(err);
                }
            });
        });
    }
}

module.exports = {
    NtpMonitor,
};
