import unittest

from backend.login_nodes import _df, _df_inodes, _merge_disk_stats


class LoginDiskParserTests(unittest.TestCase):
    def test_inode_and_byte_rows_are_merged(self):
        bytes_text = "Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/root 1000 400 600 40% /\n"
        inode_text = "Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/root 200 50 150 25% /\n"

        rows = _merge_disk_stats(_df(bytes_text), _df_inodes(inode_text))

        self.assertEqual(rows[0]["size"], 1000)
        self.assertEqual(rows[0]["inodes_total"], 200)
        self.assertEqual(rows[0]["inode_use_pct"], 25)


if __name__ == "__main__":
    unittest.main()
