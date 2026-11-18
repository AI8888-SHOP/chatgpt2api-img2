import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image
from services import upstream_image_service as upstream
from services import user_image_storage as storage
from services import generated_image_cache_service as cache_module
from services.image_service import ImageGenerationError


def image_bytes(fmt, animated=False):
    output = io.BytesIO()
    frames = [Image.new("RGB", (16, 16), color) for color in ("red", "blue")]
    frames[0].save(output, format=fmt, **({"save_all": True, "append_images": frames[1:], "duration": 100, "loop": 0} if animated else {}))
    return output.getvalue()


class MediaImageTests(unittest.TestCase):
    def setUp(self):
        self.record_cache = upstream._record_cache
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for p in (patch.object(storage, "GENERATED_IMAGES_DIR", self.root),
                  patch.object(storage.generated_image_cache_service, "record_image"),
                  patch.object(upstream, "_record_cache")):
            p.start()
            self.addCleanup(p.stop)

    def test_cache_stream_merge_has_exact_totals_and_bounded_page(self):
        cache = cache_module.GeneratedImageCacheService()
        cache._records = [{"id": "image", "created_at": 2500, "size_bytes": 7}]
        consumed = []
        def videos():
            for number in range(2000):
                consumed.append(number)
                yield {"id": str(number), "created_at": number, "size_bytes": 2, "action": "video_generate"}
        with patch.object(cache, "sync_storage"):
            result = cache.list_images(limit=3, offset=1, extra_items=videos())
        self.assertEqual([item["id"] for item in result["items"]], ["1999", "1998", "1997"])
        self.assertEqual(result["total"], 2001)
        self.assertEqual(result["total_size_bytes"], 4007)
        self.assertEqual(len(consumed), 2000)
        self.assertTrue(result["has_more"])

    def test_cache_tracks_requested_sent_and_actual_dimensions_without_secret_fields(self):
        self.record_cache("/generated-images/example.gif", "image/gif", "test", {
            "requested_size": "2048x1152", "sent_size": "2048x1152", "requested_format": "gif",
            "provider_url": "https://private.test/?signature=SECRET", "untrusted": "SECRET",
        }, image_data=image_bytes("GIF", True))
        spec = storage.generated_image_cache_service.record_image.call_args.kwargs["image_spec"]
        self.assertEqual(spec, {"requested_size": "2048x1152", "sent_size": "2048x1152", "requested_format": "gif", "actual_width": 16, "actual_height": 16, "actual_format": "gif", "frames": 2})

    def test_dimension_metadata_survives_cache_reload_and_storage_sync(self):
        with patch.object(cache_module, "DATA_FILE", self.root / "metadata.json"), patch.object(cache_module, "GENERATED_IMAGES_DIR", self.root / "images"):
            target = self.root / "images" / "test.gif"
            target.parent.mkdir()
            target.write_bytes(image_bytes("GIF", True))
            cache = cache_module.GeneratedImageCacheService()
            spec = {"requested_size": "2048x1152", "sent_size": "2048x1152", "actual_width": 16, "actual_height": 16, "actual_format": "gif"}
            cache.record_image(url="/generated-images/test.gif", image_spec=spec)
            cache.record_image(url="/generated-images/test.gif")
            restored = cache_module.GeneratedImageCacheService().list_images()["items"]
            self.assertEqual(restored[0]["image_spec"], spec)

    def test_genuine_animated_gif_base64_and_url_preserve_bytes_mime_extension(self):
        gif = image_bytes("GIF", True)
        for item in ({"b64_json": base64.b64encode(gif).decode()}, {"url": "https://example.test/result"}):
            with patch.object(upstream, "_download_image_limited", return_value=(gif, "image/png")):
                result = upstream._process_upstream_images([item], "private", output_format="gif")
            path = next(self.root.rglob(result[0]["url"].split("/")[-1]))
            self.assertEqual(path.suffix, ".gif")
            self.assertEqual(path.read_bytes(), gif)
            with Image.open(path) as image:
                self.assertEqual(image.n_frames, 2)
            self.assertEqual(upstream._record_cache.call_args.args[1], "image/gif")

    def test_static_png_cannot_masquerade_as_gif_or_escape_as_raw_result(self):
        png = image_bytes("PNG")
        for item in ({"b64_json": base64.b64encode(png).decode()}, {"url": "https://example.test/private?signature=secret"}):
            with patch.object(upstream, "_download_image_limited", return_value=(png, "image/gif")):
                with self.assertRaises(ImageGenerationError):
                    upstream._process_upstream_images([item], "private", output_format="gif")
        self.assertEqual(list(self.root.rglob("*.gif")), [])

    def test_other_formats_are_detected_from_bytes(self):
        for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            result = upstream._process_upstream_images([{"b64_json": base64.b64encode(image_bytes(fmt)).decode()}], "test")
            self.assertEqual(upstream._record_cache.call_args.args[1], mime)
            self.assertTrue(result[0]["url"])

    def test_generic_format_and_gif_mismatch_errors_are_distinct(self):
        with self.assertRaisesRegex(ImageGenerationError, "上游图片数据无效"):
            upstream._verified_image_type(b"not an image")
        with self.assertRaisesRegex(ImageGenerationError, "不支持的上游图片格式"):
            upstream._verified_image_type(image_bytes("BMP"))
        with self.assertRaisesRegex(ImageGenerationError, "请求 GIF"):
            upstream._verified_image_type(image_bytes("PNG"), "gif")

    def test_later_invalid_image_does_not_publish_earlier_valid_image(self):
        batch = [{"b64_json": base64.b64encode(image_bytes("GIF", True)).decode()}, {"b64_json": "not-base64"}]
        with self.assertRaises(ImageGenerationError):
            upstream._process_upstream_images(batch, "test", output_format="gif")
        self.assertEqual(list(self.root.rglob("*.gif")), [])
        upstream._record_cache.assert_not_called()

    def test_later_file_or_metadata_failure_rolls_back_only_this_batch(self):
        save = upstream.save_generated_image
        gif = image_bytes("GIF", True)
        for failure in ("save", "metadata"):
            with self.subTest(failure=failure), patch.object(cache_module, "DATA_FILE", self.root / (failure + ".json")), patch.object(cache_module, "GENERATED_IMAGES_DIR", self.root / failure), patch.object(storage, "GENERATED_IMAGES_DIR", self.root / failure):
                cache = cache_module.GeneratedImageCacheService()
                existing = self.root / failure / "existing.gif"
                existing.parent.mkdir()
                existing.write_bytes(gif)
                cache.record_image(url="/generated-images/existing.gif")
                save_calls, record_calls = [], []
                def save_image(*args, **kwargs):
                    save_calls.append(1)
                    if failure == "save" and len(save_calls) == 2:
                        raise OSError("synthetic disk failure")
                    return save(*args, **kwargs)
                def record(*args, **kwargs):
                    record_calls.append(1)
                    if failure == "metadata" and len(record_calls) == 2:
                        raise OSError("synthetic metadata failure")
                    return self.record_cache(*args, **kwargs)
                with patch.object(upstream, "generated_image_cache_service", cache), patch.object(upstream, "save_generated_image", side_effect=save_image), patch.object(upstream, "_record_cache", side_effect=record):
                    with self.assertRaises(ImageGenerationError):
                        upstream._process_upstream_images([{"b64_json": base64.b64encode(gif).decode()}] * 2, "test", output_format="gif")
                self.assertEqual(list((self.root / failure).rglob("*.gif")), [existing])
                self.assertEqual([item["url"] for item in cache_module.GeneratedImageCacheService().list_images()["items"]], ["/generated-images/existing.gif"])

    def test_generation_and_edit_forward_one_size_and_gif_field(self):
        channel = {"models": ["gpt-image-2.6"], "base_url": "https://provider.test/v1", "api_key": "synthetic"}
        client = MagicMock()
        client.__enter__.return_value = client
        client.post.return_value.json.return_value = {"data": [{"b64_json": base64.b64encode(image_bytes("GIF", True)).decode()}]}
        with patch.object(upstream, "_choose_upstream", return_value=channel), patch.object(upstream, "_get_client", return_value=client):
            for size in ("2048x1152", "1152x2048", "4096x4096", "auto"):
                upstream.generate_image_upstream("test", model="gpt-image-2.6", size=size, output_format="gif")
                generation = client.post.call_args.kwargs["json"]
                upstream.edit_image_upstream("test", [(image_bytes("PNG"), "ref.png", "image/png")], model="gpt-image-2.6", size=size, output_format="gif")
                edit = client.post.call_args.kwargs["data"]
                for fields in (generation, edit):
                    self.assertEqual(fields.get("size"), None if size == "auto" else size)
                    self.assertEqual(fields["output_format"], "gif")
                    self.assertFalse({"width", "height", "resolution", "aspect_ratio"} & fields.keys())

    def test_unsupported_model_gif_rejected_before_post(self):
        channel = {"models": ["grok-imagine-image"]}
        with patch.object(upstream, "_choose_upstream", return_value=channel), patch.object(upstream, "_get_client") as client:
            with self.assertRaises(ImageGenerationError):
                upstream.generate_image_upstream("test", model="grok-imagine-image", output_format="gif")
            client.assert_not_called()
