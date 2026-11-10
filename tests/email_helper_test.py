import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "email_helper.py"
SPEC = importlib.util.spec_from_file_location("ustc_email_helper", MODULE_PATH)
email_helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(email_helper)

TEST_CONFIG = {
    "sender": "sender@example.com",
    "recipient": "recipient@example.net",
    "smtpHost": "smtp.example.com",
    "smtpPort": 465,
}


class EmailHelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.state_file = Path(self.temporary_directory.name) / "sent.json"
        self.report = {
            "id": "report-1",
            "title": "测试学术报告",
            "location": "测试校区报告厅",
            "reportTime": "2026-11-18 10:00",
            "deadline": "2026-11-15 23:59:59",
        }

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_same_report_is_never_emailed_twice(self):
        with (
            patch.object(email_helper, "load_config", return_value=TEST_CONFIG),
            patch.object(email_helper, "smtp_deliver") as deliver,
        ):
            first = email_helper.send_report(self.report, state_file=self.state_file)
            second = email_helper.send_report(self.report, state_file=self.state_file)
        self.assertFalse(first["alreadySent"])
        self.assertTrue(second["alreadySent"])
        self.assertEqual(deliver.call_count, 1)

    def test_message_uses_each_users_sender_and_recipient(self):
        report = {**self.report, "title": "第一行\r\n第二行"}
        message = email_helper.build_message(email_helper.normalize_report(report), TEST_CONFIG)
        self.assertEqual(message["From"], "sender@example.com")
        self.assertEqual(message["To"], "recipient@example.net")
        self.assertNotIn("\n", message["Subject"])
        self.assertIn("第一行 第二行", message["Subject"])

    def test_different_recipients_have_independent_deduplication_files(self):
        other_config = {**TEST_CONFIG, "recipient": "other@example.org"}
        self.assertNotEqual(
            email_helper.sent_file_for(TEST_CONFIG),
            email_helper.sent_file_for(other_config),
        )

    def test_health_check_accepts_extension_get_without_origin_but_send_does_not(self):
        self.assertTrue(email_helper.valid_health_origin(""))
        self.assertTrue(email_helper.valid_health_origin("null"))
        self.assertTrue(email_helper.valid_health_origin("chrome-extension://abc"))
        self.assertFalse(email_helper.valid_health_origin("https://example.com"))
        self.assertFalse(email_helper.valid_origin(""))

    def test_invalid_report_id_is_rejected_before_smtp(self):
        with patch.object(email_helper, "smtp_deliver") as deliver:
            with self.assertRaises(ValueError):
                email_helper.send_report({**self.report, "id": "bad id!"}, state_file=self.state_file)
        deliver.assert_not_called()

    def test_failed_smtp_send_is_not_marked_as_sent(self):
        with (
            patch.object(email_helper, "load_config", return_value=TEST_CONFIG),
            patch.object(email_helper, "smtp_deliver", side_effect=[RuntimeError("offline"), None]) as deliver,
        ):
            with self.assertRaises(RuntimeError):
                email_helper.send_report(self.report, state_file=self.state_file)
            result = email_helper.send_report(self.report, state_file=self.state_file)
        self.assertFalse(result["alreadySent"])
        self.assertEqual(deliver.call_count, 2)


if __name__ == "__main__":
    unittest.main()
