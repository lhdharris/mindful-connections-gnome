import subprocess
import sys
import argparse
import platform
import abc
import os
import shutil

class FirewallController(abc.ABC):
    @abc.abstractmethod
    def block(self):
        pass

    @abc.abstractmethod
    def unblock(self):
        pass

    @abc.abstractmethod
    def is_blocked(self) -> bool:
        pass

class NftablesController(FirewallController):
    """Firewall controller using nftables (default on Debian 12+, Ubuntu 22.04+)."""
    TABLE = "mindful_connections"

    @staticmethod
    def _find_nft() -> str:
        for candidate in ["nft", "/usr/sbin/nft", "/sbin/nft"]:
            found = shutil.which(candidate)
            if found:
                return found
        raise FileNotFoundError(
            "nft not found. Install it with: sudo apt install nftables"
        )

    def _run(self, args: list[str]):
        result = subprocess.run(args, capture_output=True, text=True)
        return result.returncode, (result.stdout + result.stderr).strip()

    def _run_script(self, script: str):
        result = subprocess.run(
            [self._find_nft(), "-f", "-"],
            input=script, capture_output=True, text=True,
        )
        return result.returncode, (result.stdout + result.stderr).strip()

    def block(self):
        # Delete any existing table so we start clean (ignore errors)
        self._run([self._find_nft(), "delete", "table", "ip", self.TABLE])
        script = (
            f"table ip {self.TABLE} {{\n"
            f"    chain output {{\n"
            f"        type filter hook output priority 0; policy accept;\n"
            f"        tcp dport {{ 80, 443 }} reject with tcp reset\n"
            f"        udp dport 443 reject\n"
            f"    }}\n"
            f"}}\n"
        )
        code, out = self._run_script(script)
        if code != 0:
            raise RuntimeError(f"nft block failed: {out}")

    def unblock(self):
        self._run([self._find_nft(), "delete", "table", "ip", self.TABLE])

    def is_blocked(self) -> bool:
        code, _ = self._run([self._find_nft(), "list", "table", "ip", self.TABLE])
        return code == 0


class LinuxController(FirewallController):
    RULES = [
        ["-p", "tcp", "--dport", "80",  "-j", "REJECT", "--reject-with", "tcp-reset"],
        ["-p", "tcp", "--dport", "443", "-j", "REJECT", "--reject-with", "tcp-reset"],
        ["-p", "udp", "--dport", "443", "-j", "REJECT"],
    ]

    @staticmethod
    def _find_iptables() -> str:
        for candidate in ["iptables", "/usr/sbin/iptables", "/sbin/iptables"]:
            found = shutil.which(candidate)
            if found:
                return found
        raise FileNotFoundError(
            "iptables not found. Install it with: sudo apt install iptables"
        )

    def _run(self, args: list[str]):
        result = subprocess.run(args, capture_output=True, text=True)
        return result.returncode, (result.stdout + result.stderr).strip()

    def _rule_exists(self, rule: list[str]) -> bool:
        ipt = self._find_iptables()
        code, _ = self._run([ipt, "-C", "OUTPUT"] + rule)
        return code == 0

    def block(self):
        ipt = self._find_iptables()
        for rule in self.RULES:
            if not self._rule_exists(rule):
                self._run([ipt, "-I", "OUTPUT"] + rule)

    def unblock(self):
        ipt = self._find_iptables()
        for rule in self.RULES:
            for _ in range(5):
                if self._rule_exists(rule):
                    self._run([ipt, "-D", "OUTPUT"] + rule)
                else:
                    break

    def is_blocked(self) -> bool:
        return self._rule_exists(self.RULES[0])

class WindowsController(FirewallController):
    RULE_NAME = "MindfulConnectionsBlock"

    def block(self):
        # Block outbound TCP ports 80 and 443
        for port in ["80", "443"]:
            subprocess.run([
                "netsh", "advfirewall", "firewall", "add", "rule",
                f"name={self.RULE_NAME}_TCP_{port}", "dir=out", "action=block",
                "protocol=TCP", f"remoteport={port}"
            ], capture_output=True)
        # Block outbound UDP 443 (QUIC/HTTP3)
        subprocess.run([
            "netsh", "advfirewall", "firewall", "add", "rule",
            f"name={self.RULE_NAME}_UDP_443", "dir=out", "action=block",
            "protocol=UDP", "remoteport=443"
        ], capture_output=True)

    def unblock(self):
        for rule in [f"{self.RULE_NAME}_TCP_80", f"{self.RULE_NAME}_TCP_443", f"{self.RULE_NAME}_UDP_443"]:
            subprocess.run([
                "netsh", "advfirewall", "firewall", "delete", "rule", f"name={rule}"
            ], capture_output=True)

    def is_blocked(self) -> bool:
        res = subprocess.run([
            "netsh", "advfirewall", "firewall", "show", "rule",
            f"name={self.RULE_NAME}_TCP_80"
        ], capture_output=True, text=True)
        return "No rules match" not in res.stdout

class MacController(FirewallController):
    RULE_CONTENT_TCP = "block out proto tcp from any to any port {80, 443}"
    RULE_CONTENT_UDP = "block out proto udp from any to any port 443"

    @property
    def _anchor_file(self) -> str:
        # Write to a user-owned location so only pfctl itself needs root,
        # not the file write.
        d = os.path.expanduser("~/Library/Application Support/MindfulConnections")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "pf.rules")

    def block(self):
        with open(self._anchor_file, "w") as f:
            f.write(f"{self.RULE_CONTENT_TCP}\n{self.RULE_CONTENT_UDP}\n")
        subprocess.run(["sudo", "/sbin/pfctl", "-a", "mindful", "-f", self._anchor_file], capture_output=True)
        subprocess.run(["sudo", "/sbin/pfctl", "-e"], capture_output=True)

    def unblock(self):
        subprocess.run(["sudo", "/sbin/pfctl", "-a", "mindful", "-F", "all"], capture_output=True)

    def is_blocked(self) -> bool:
        res = subprocess.run(
            ["/sbin/pfctl", "-s", "rules", "-a", "mindful"],
            capture_output=True, text=True,
        )
        return self.RULE_CONTENT_TCP in res.stdout

def get_controller() -> FirewallController:
    os_name = platform.system()
    if os_name == "Linux":
        # Prefer nftables (default on Debian 12+, Ubuntu 22.04+); fall back to iptables.
        if shutil.which("nft"):
            return NftablesController()
        return LinuxController()
    elif os_name == "Windows":
        return WindowsController()
    elif os_name == "Darwin":
        return MacController()
    else:
        raise NotImplementedError(f"Unsupported OS: {os_name}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Control internet browsing across platforms")
    parser.add_argument("--action", choices=["block", "unblock", "status"], required=True)
    args = parser.parse_args()

    controller = get_controller()
    if args.action == "block":
        controller.block()
    elif args.action == "unblock":
        controller.unblock()
    elif args.action == "status":
        print("blocked" if controller.is_blocked() else "open")

