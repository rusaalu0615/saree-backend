import User from "../modal/userModal.js"
import generateToken from "../utils/generateToken.js"
import bcrypt from "bcrypt"

const registerUser = async (req, res) => {
    const { name, email, phone, password } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
        return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
        name,
        email,
        phone,
        password: hashedPassword,
    });

    const token = generateToken(user._id);
    res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        token: token,
    })
}

const loginUser = async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email })
    if (!user) {
        return res.status(400).json({ message: "User not found" })
    }

    if (!password || !user.password) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
        return res.status(400).json({ message: "Invalid email or password" })
    }

    const token = generateToken(user._id);
    res.status(200).json({
        user,
        token,
        message: "Login successfull",
    })
}

export default { registerUser, loginUser }