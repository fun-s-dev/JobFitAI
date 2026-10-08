const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 3 * 1024 * 1024 // 3MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "application/pdf") {
            const err = new Error("Invalid file type. Only PDF files are allowed.");
            err.code = "INVALID_FILE_TYPE";
            return cb(err, false);
        }
        cb(null, true);
    }
});

function uploadResume(req, res, next) {
    upload.single("resume")(req, res, (err) => {
        if (err) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({
                    message: "File too large. Maximum size is 3 MB."
                });
            }
            if (err.code === "INVALID_FILE_TYPE") {
                return res.status(415).json({
                    message: err.message
                });
            }
            return res.status(400).json({
                message: err.message || "File upload error."
            });
        }

        if (req.file) {
            const buffer = req.file.buffer;
            if (!buffer || buffer.length < 5 || buffer.slice(0, 5).toString('ascii') !== '%PDF-') {
                return res.status(415).json({
                    message: "Invalid file content. File must be a valid PDF."
                });
            }
        }

        next();
    });
}

uploadResume.single = () => uploadResume;
uploadResume.uploadResume = uploadResume;

module.exports = uploadResume;