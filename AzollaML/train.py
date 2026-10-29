from pathlib import Path
from ultralytics import YOLO


def main():
    model = YOLO("yolo26n-seg.pt")

    print("Starting YOLO26 segmentation training...")

    results = model.train(
        data="AzollaSense.v2/data.yaml",
        epochs=300,
        patience=50,
        imgsz=640,
        batch=16,
        device=0,
        workers=8,
        save_period=25,
        plots=True,
        project="runs/segment",
        name="azollasense",
    )

    print("Training complete! Validating best model...")

    # Get the best checkpoint from this specific training run
    best_weights = Path(results.save_dir) / "weights" / "best.pt"

    if not best_weights.exists():
        raise FileNotFoundError(f"Best checkpoint not found: {best_weights}")

    custom_model = YOLO(str(best_weights))

    # Evaluate the best checkpoint on the validation dataset
    custom_model.val(
        data="AzollaSense.v2/data.yaml",
        imgsz=640,
        device=0,
    )

    print("Exporting trained model to NCNN...")

    custom_model.export(format="ncnn", imgsz=640)

    print("Export complete!")
    print(f"Best weights: {best_weights}")
    print("Test the exported model on the Raspberry Pi 5.")


if __name__ == "__main__":
    main()
