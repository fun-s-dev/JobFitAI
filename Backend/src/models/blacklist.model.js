const mongoose = require('mongoose');

const blacklistTokenSchema = new mongoose.Schema({
    token:{
        type: String,
        required: [true, "Token is required"]
    }
},
    {
        timestamps: true
    })

blacklistTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

const tokenBlacklistModel = mongoose.model("blacklistToken", blacklistTokenSchema ) //iss collection ka naam blacklistTokens hoga

module.exports = tokenBlacklistModel