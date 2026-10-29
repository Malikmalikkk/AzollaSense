from ultralytics import YOLO

# Load your existing trained weights
custom_model = YOLO('../runs/segment/train/weights/best.pt')

# Export to NCNN format for the Pi 5
custom_model.export(format='ncnn')
print("Export complete! You're ready to deploy to the Pi 5.")