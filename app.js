// server.js
"use strict";

const express = require("express");
const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");

const app = express();
app.use(express.json());
const port = 3000;

// ======== CONFIG (move these to env in production) ========
const AUTH_TOKEN = "MzFbuSwiE9GX/ECaUVLFvJE69j5JdJzr/p0HV0gmxX0=";

const sshConfig = {
  host: "192.168.50.240",
  port: 22,
  username: "root",
  password: "6yHnmju&",
};

// Remote paths / commands for Proxmox (adjust as needed)
const REMOTE_UPLOAD_DIR = "/tmp"; // must exist on Proxmox host
// ==========================================================

// ---------- Utils ----------
function headerHasToken(req, token) {
  const auth = req.header("Authorization") || "";
  if (!auth) return false;
  if (auth === token) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === token)
    return true;
  return false;
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// ---------- SSH Helpers ----------
function executeSSHCommand(command, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      conn.end();
      if (err) return reject(err);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(`SSH command timed out after ${timeoutMs} ms: ${command}`)
      );
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return finish(err);
          stream
            .on("close", (code) => {
              finish(null, {
                code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
              });
            })
            .on("data", (data) => {
              stdout += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            });
        });
      })
      .on("error", (err) => finish(err))
      .connect(sshConfig);
  });
}

function sftpUpload(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          const readStream = fs.createReadStream(localPath);
          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on("close", () => {
            conn.end();
            resolve({ ok: true, remotePath });
          });
          writeStream.on("error", (e) => {
            conn.end();
            reject(e);
          });
          readStream.pipe(writeStream);
        });
      })
      .on("error", (e) => reject(e))
      .connect(sshConfig);
  });
}

// ---------- Auth middleware ----------
app.use((req, res, next) => {
  if (!headerHasToken(req, AUTH_TOKEN)) {
    return res.status(401).json({ status: "error", error: "Unauthorized" });
  }
  next();
});

app.get("/", (req, res) => {
  res.send("TDG Cyber");
});

// ---------- VM action map ----------
const ACTIONS = new Set(["start", "stop", "restart", "remove"]);

async function runQm(vmid, action) {
  if (!isPositiveInt(vmid)) throw new Error("Invalid vm_id");
  if (!ACTIONS.has(action)) throw new Error("Invalid action");

  if (action === "start") {
    return await executeSSHCommand(`qm start ${vmid}`);
  }
  if (action === "stop") {
    // Force stop; replace with 'qm shutdown' if you want graceful
    return await executeSSHCommand(`qm stop ${vmid}`);
  }
  if (action === "restart") {
    // Proxmox has 'qm reset' or do stop+start:
    return await executeSSHCommand(`qm stop ${vmid} && qm start ${vmid}`);
  }
  if (action === "remove") {
    // DANGEROUS: this destroys the VM (uncomment intentionally)
    // return await executeSSHCommand(`qm destroy ${vmid} --purge 1`);
    return await executeSSHCommand(`qm stop ${vmid} && qm destroy ${vmid}`);
  }

 
}

// ---------- Routes ----------
app.post("/manageVm", async (req, res) => {
  try {
    const { vm_id, action } = req.body || {};
    const vmid = Number(vm_id);

    if (!isPositiveInt(vmid)) {
      return res.status(400).json({ status: "error", error: "Invalid vm_id" });
    }
    if (!ACTIONS.has(action)) {
      return res
        .status(400)
        .json({
          status: "error",
          error: "Invalid action. Use start/stop/restart[/remove]",
        });
    }

    const result = await runQm(vmid, action);
    const ok = result.code === 0 && !/error/i.test(result.stderr);

    // return res.json({
    //   status: ok ? "ok" : "error",
    //   data: {
    //     vm_id: vmid,
    //     action,
    //     exitCode: result.code,
    //     output: result.stdout,
    //     stderr: result.stderr,
    //   },
    //   ...(ok ? {} : { error: result.stderr || "qm command failed" }),
    // });
     return res.json({ status: 'ok' });
  } catch (e) {
    return res
      .status(500)
      .json({ status: "error", error: e.message || "Internal error" });
  }
});

app.post("/removeTemplate", async (req, res) => {
  console.log("welcome to removeTemplate");
  try {
    const { vm_id } = req.body || {};
    const vmid = Number(vm_id);

    if (!isPositiveInt(vmid)) {
      return res.status(400).json({ status: "error", error: "Invalid vm_id" });
    }


    const result = await runQm(vmid, "remove");
    const ok = result.code === 0 && !/error/i.test(result.stderr);

    return res.json({
      status: ok ? "ok" : "error",
      data: {
        vm_id: vmid,
        exitCode: result.code,
        output: result.stdout,
        stderr: result.stderr,
      },
      ...(ok ? {} : { error: result.stderr || "qm command failed" }),
    });
  } catch (e) {
    return res
      .status(500)
      .json({ status: "error", error: e.message || "Internal error" });
  }
});
app.post("/vm", async (req, res) => {
  try {
    const { vm_id } = req.body || {};
    const vmid = Number(vm_id);
    if (!isPositiveInt(vmid)) {
      return res.status(400).json({ status: "error", error: "Invalid vm_id" });
    }

    const result = await executeSSHCommand(`qm status ${vmid}`);
    // Typical output: "status: running" or "status: stopped"
    let status = "ok";
    const out = `${result.stdout}\n${result.stderr}`.toLowerCase();

    if (/status:\s*running/.test(out) || /run/.test(out)) status = "online";
    else if (/status:\s*stopped/.test(out) || /stop/.test(out))
      status = "offline";
    else if (/no such vm|not found|does not exist/.test(out))
      status = "not found";

    return res.json({
      status: status,
      data: {
        vm_id: vmid,
        raw: result.stdout || result.stderr,
        exitCode: result.code,
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ status: "error", error: e.message || "Internal error" });
  }
});

app.post("/cloneVm", async (req, res) => {

  try {
    const { vm_id, new_vm_id, option } = req.body || {};
    const vmid = Number(vm_id);
    const newvmid = Number(new_vm_id);

    if (!isPositiveInt(vmid)) {
      return res.status(400).json({ status: "error", error: "Invalid vm_id" });
    }

    if (!isPositiveInt(newvmid)) {
      return res
        .status(400)
        .json({ status: "error", error: "Invalid new_vm_id" });
    }

    let result = await executeSSHCommand(`qm status ${vmid}`);
    let out = `${result.stdout}\n${result.stderr}`.toLowerCase();

    if (/no such vm|not found|does not exist/.test(out)) {
      return res.json({
        status: "error",
        error: `not found vm_id ${vmid}`,
      });
    }

    result = await executeSSHCommand(`qm status ${newvmid}`);
    out = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if(/status:\s*running/.test(out) || /run/.test(out)) {
      return res.json({
        status: "error",
        error: `Existing vm_id ${newvmid} please change new_vm_id`,
      });
    }   
     if (/status:\s*stopped/.test(out) || /stop/.test(out)){
      return res.json({
        status: "error",
        error: `Existing vm_id ${newvmid} please change new_vm_id`,
      });
    }
    result = await executeSSHCommand(
      `nohup qm clone ${vmid} ${newvmid} ${option} & `
    );
    // Typical output: "status: running" or "status: stopped"


    return res.json({
      status: "ok",
    });
  } catch (e) {
    return res
      .status(500)
      .json({ status: "error", error: e.message || "Internal error" });
  }
});
// ---------- /importVm (multipart) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(os.tmpdir(), "vm_uploads");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // keep original name; you may want to sanitize further
      cb(null, `${Date.now()}_${file.originalname}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 * 50 }, // 50 GB, adjust as needed
});

app.post("/importVm", upload.single("vm_file"), async (req, res) => {
  // Client sample (fields):

  try {
    let { vm_id, vm_name, vm_cpu_core, vm_memory, vm_os_type, vm_network } =
      req.body || {};
    let vmid = Number(vm_id);
    if (!isPositiveInt(vmid)) {
      return res.status(400).json({ status: "error", error: "Invalid vm_id" });
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ status: "error", error: "Missing vm_file" });
    }

    if (vm_os_type == "" || vm_os_type == "unix") {
      vm_os_type = "unix";
    } else if ((vm_os_type = "windows")) {
      vm_os_type = "windows";
    } else {
      {
        status: "error", "vm_os_type have unix/windows";
      }
    }

    if (vm_network == "") {
      vm_network = "virtio,bridge=Trunk,tag=1";
    }

    const localPath = req.file.path;
    const remoteFileName = path.basename(localPath);
    const remotePath = `${REMOTE_UPLOAD_DIR}/${remoteFileName}`;

    // 1) Upload disk image/OVA to Proxmox
    const up = await sftpUpload(localPath, remotePath);

    // 2) (OPTIONAL) Create VM and import disk — adjust to your format (qcow2/raw/vmdk/ova)
    // Example for a raw/qcow2 disk you want as scsi0 on local-lvm:
    // - Create empty VM
    // - Import disk
    // - Attach disk & set SCSI controller
    // - Set cores/memory/name
    // NOTE: tune storage target (e.g., 'local-lvm') and bus accordingly.
    let cmds = "";
    if (vm_os_type == "unix") {
      cmds = [
        `qm create ${vmid} --name ${vm_name || `vm-${vmid}`} --memory ${
          Number(vm_memory) || 2048
        } --cores ${Number(vm_cpu_core) || 2} --net0 ${vm_network}`,
        // Import disk into storage 'local-lvm' (change to your storage)
        `qm importdisk ${vmid} ${remotePath} local-lvm`,
        // Find the imported disk name and attach it as scsi0
        // (Proxmox usually names it something like 'local-lvm:vm-${vmid}-disk-0')
        // Simple approach: attach the first found disk
        `DISK=$(pvesm list local-lvm | awk -v id=${vmid} '$1 ~ ("vm-" id "-disk-") {print $1; exit}'); qm set ${vmid} --scsihw virtio-scsi-pci --scsi0 "$DISK"`,
        // Boot from scsi0
        `qm set ${vmid} --boot order=scsi0`,
        `qm start ${vmid}`,
      ];
    } else if (vm_os_type == "windows") {
      cmds = [
        `qm create ${vmid} --name ${vm_name || `vm-${vmid}`} --memory ${
          Number(vm_memory) || 4096
        } --cores ${Number(vm_cpu_core) || 2} --machine q35 --bios ovmf`,
        // Import disk into storage 'local-lvm' (change to your storage)
        `qm set ${vmid} --efidisk0 VMs:0,pre-enrolled-keys=1`,
        `qm importdisk ${vmid} ${remotePath} local-lvm`,
        // Find the imported disk name and attach it as scsi0
        // (Proxmox usually names it something like 'local-lvm:vm-${vmid}-disk-0')
        // Simple approach: attach the first found disk
        `DISK=$(pvesm list local-lvm | awk -v id=${vmid} '$1 ~ ("vm-" id "-disk-") {print $1; exit}'); qm set ${vmid} --sata0 VMs:${vmid}/"$DISK"`,
        `DISK=$(pvesm list local-lvm | awk -v id=${vmid} '$1 ~ ("vm-" id "-disk-") {print $1; exit}'); qm set ${vmid} --sata0 VMs:"$DISK"`,
        // Boot from scsi0
        `qm set ${vmid} --boot order=sata0`,
        `qm set ${vmid} --net0 ${vm_network}`,
        `qm start ${vmid}`,
      ];
    }

    // Allow skipping creation if only upload is needed:
    let execLog = [];

      for (const c of cmds) {
        const r = await executeSSHCommand(c);
        execLog.push({ cmd: c, code: r.code, out: r.stdout, err: r.stderr });
        if (r.code !== 0) {
          return res.status(500).json({
            status: "error",
            error: `Failed on: ${c}`,
            data: { upload: up, steps: execLog },
          });
        }
      }


    //3) (OPTIONAL) Start VM
    // const start = await executeSSHCommand(`qm start ${vmid}`);
    // execLog.push({ cmd: `qm start ${vmid}`, code: start.code, out: start.stdout, err: start.stderr });
    await executeSSHCommand(`rm ${remotePath}`);

    return res.json({
      status: "ok",
      data: {
        vm_id: vmid,
        uploaded: up,
        steps: execLog,
        note: "Adjust storage names and import steps to match your Proxmox setup.",
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ status: "error", error: e.message || "Internal error" });
  } finally {
    // cleanup local temp file
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
  }
});

// ---------- Start ----------
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
