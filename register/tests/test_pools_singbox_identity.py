"""Sing-Box 本地入口的节流身份测试。

订阅节点的公网出口可能动态轮换；节流必须优先使用稳定的 route.final 节点
tag，只有运行配置缺少节点 tag 时才退回公网 IP，不能每次把动态 IP 当新出口。
"""
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pools  # noqa: E402


class SingBoxIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(__file__).resolve().parent / "_tmp_singbox_identity"
        self.tmpdir.mkdir(exist_ok=True)
        self.cfg = self.tmpdir / "config.json"
        self.state = self.tmpdir / "proxy_ip_state.json"
        self.sb_cfg = self.tmpdir / "sing-box.json"
        self.cfg.write_text(
            json.dumps(
                {
                    "singbox_enabled": True,
                    "proxy_enabled": True,
                    "proxy": "http://127.0.0.1:2080",
                    "browser_proxy": "http://127.0.0.1:2080",
                    "proxy_ip_interval_sec": 60,
                }
            ),
            encoding="utf-8",
        )
        self.sb_cfg.write_text(
            json.dumps({"route": {"final": "node-a"}}), encoding="utf-8"
        )
        self.state.write_text(json.dumps({"last_used": {}}), encoding="utf-8")

        self.orig_config_path = pools._config_path
        self.orig_state_path = pools._ip_state_path
        pools._config_path = lambda: self.cfg  # type: ignore[assignment]
        pools._ip_state_path = lambda: self.state  # type: ignore[assignment]
        pools._proxy_list = []
        pools._proxy_idx = 0
        pools._proxy_last_used.clear()
        pools._loaded = False
        pools._proxy_ip_interval_sec = 0.0
        pools._singbox_identity_cache.clear()

        self.old_runtime_path = os.environ.get("SINGBOX_RUNTIME_CONFIG_PATH")
        os.environ["SINGBOX_RUNTIME_CONFIG_PATH"] = str(self.sb_cfg)

    def tearDown(self):
        pools._config_path = self.orig_config_path  # type: ignore[assignment]
        pools._ip_state_path = self.orig_state_path  # type: ignore[assignment]
        pools._proxy_list = []
        pools._proxy_idx = 0
        pools._proxy_last_used.clear()
        pools._loaded = False
        pools._proxy_ip_interval_sec = 0.0
        pools._singbox_identity_cache.clear()
        if self.old_runtime_path is None:
            os.environ.pop("SINGBOX_RUNTIME_CONFIG_PATH", None)
        else:
            os.environ["SINGBOX_RUNTIME_CONFIG_PATH"] = self.old_runtime_path
        for path in self.tmpdir.glob("*"):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            self.tmpdir.rmdir()
        except OSError:
            pass

    def test_singbox_identity_prefers_active_node_tag_without_network_probe(self):
        with patch.object(
            pools,
            "_probe_singbox_exit_ip",
            return_value="203.0.113.10",
            create=True,
        ) as probe:
            self.assertEqual(
                pools.proxy_identity_key("http://127.0.0.1:2080"),
                "singbox-node:node-a",
            )
            probe.assert_not_called()

    def test_singbox_identity_falls_back_to_exit_ip_without_node_tag(self):
        self.sb_cfg.write_text(json.dumps({"route": {}}), encoding="utf-8")
        with patch.object(
            pools,
            "_probe_singbox_exit_ip",
            return_value="203.0.113.10",
            create=True,
        ) as probe:
            self.assertEqual(
                pools.proxy_identity_key("http://127.0.0.1:2080"),
                "singbox-ip:203.0.113.10",
            )
            probe.assert_called_once_with("http://127.0.0.1:2080")

    def test_non_singbox_loopback_keeps_host_port_identity(self):
        self.cfg.write_text(
            json.dumps(
                {
                    "singbox_enabled": False,
                    "proxy_enabled": True,
                    "proxy": "http://127.0.0.1:2080",
                }
            ),
            encoding="utf-8",
        )
        with patch.object(
            pools,
            "_probe_singbox_exit_ip",
            return_value="203.0.113.10",
            create=True,
        ) as probe:
            self.assertEqual(
                pools.proxy_identity_key("http://127.0.0.1:2080"),
                "127.0.0.1:2080",
            )
            probe.assert_not_called()

    def test_acquire_ignores_legacy_local_port_state_when_node_tag_available(self):
        self.state.write_text(
            json.dumps({"last_used": {"127.0.0.1:2080": time.time()}}),
            encoding="utf-8",
        )
        with patch.object(
            pools,
            "_probe_singbox_exit_ip",
            return_value="203.0.113.10",
            create=True,
        ), patch.object(
            pools.time,
            "sleep",
            side_effect=AssertionError("legacy local-port key caused a wait"),
        ):
            picked, waited = pools.acquire_proxy_for_register(
                "", log=lambda _msg: None
            )

        self.assertEqual(picked, "http://127.0.0.1:2080")
        self.assertEqual(waited, 0.0)
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertIn("singbox-node:node-a", state["last_used"])

    def test_same_active_node_still_obeys_cooldown(self):
        self.state.write_text(
            json.dumps({"last_used": {"singbox-node:node-a": time.time()}}),
            encoding="utf-8",
        )
        with patch.object(
            pools,
            "_probe_singbox_exit_ip",
            return_value="203.0.113.10",
            create=True,
        ), patch.object(
            pools.time,
            "sleep",
            side_effect=AssertionError("same Sing-Box node was not throttled"),
        ):
            with self.assertRaisesRegex(AssertionError, "same Sing-Box node"):
                pools.acquire_proxy_for_register("", log=lambda _msg: None)


if __name__ == "__main__":
    unittest.main()
