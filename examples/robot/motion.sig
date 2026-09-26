# Motion signals for the robot arm
signal speed: number
signal position: number

connect speed -> motor
connect position -> encoder
