const express = require('express')
const colors = require('colors')
const dotenv = require('dotenv').config()
const port = process.env.PORT || 5000
const {errorHandler} = require('./middleware/errorMiddleware')
const connectDB = require('./config/db')
const cors = require('cors');


connectDB()

const app = express()

app.use(express.json())
app.use(express.urlencoded({extended: false}))
app.use(cors());
console.log('JWT_SECRET:', process.env.JWT_SECRET_NODE);


app.use('/api/meditations', require('./routes/meditationRoutes'))
app.use('/api/white_noise', require('./routes/whiteNoseRoutes'))
app.use('/api/user', require('./routes/userRoutes'))
app.use('/api/ai', require("./routes/dashboardRoutes"))

app.use(errorHandler)

app.listen(port, ()=> console.log(`Server started on port ${port}`))