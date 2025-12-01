const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    reviewId: { type: String, required: true },
    reviewerName: String,
    stars: Number,
    text: String,
    publishedAtDate: Date,
    reviewImageUrls: [String],
  },
  { _id: false }
);

const marinaSchema = new mongoose.Schema(
  {
    placeId: { type: String, required: true, unique: true },

    title: String,
    address: String,
    city: String,
    countryCode: String,

    location: {
      lat: Number,
      lng: Number,
    },

    categoryName: String,
    website: String,
    phone: String,
    totalScore: Number,
    reviewsCount: Number,

    imageUrls: [String],
    imageUrl: String,
    reviews: [reviewSchema],
    bookingLinks: [Object],

    scrapedAt: Date,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Marina", marinaSchema);
