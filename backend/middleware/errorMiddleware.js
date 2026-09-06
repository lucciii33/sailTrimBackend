const errorHandler = (err, req, res, next) => {
    let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500

    if (err.name === 'CastError' && err.kind === 'ObjectId') {
        statusCode = 400
        return res.status(400).json({ message: 'Invalid id format' })
    }

    res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack
    })
}

module.exports = {
    errorHandler
}